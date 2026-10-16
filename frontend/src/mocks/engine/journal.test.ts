import { beforeEach, describe, expect, it } from 'vitest';
import type { Actor, DocLine } from '@/domain/types';
import { PERMISSIONS_BY_ROLE } from '../permissions';
import { buildSeedState, type MockState } from '../store';
import { cancel, compute, createDraft, issue, revise } from './commands';
import { checkInvariants } from './invariants';
import { generalJournal, reverseJv } from './journal';
import { derivedLocks } from './locks';
import type { MockError } from './log';
import { toSatang } from './money';
import { trialBalance } from './reports/trial-balance';

const ME: Actor = { kind: 'user', id: 'u-1', name: 'สมศรี บัญชีดี' };
const CO = 'co-vat', TODAY = '2026-10-14';
let st: MockState, n = 0;
beforeEach(() => { localStorage.clear(); st = buildSeedState(); });

const err = (fn: () => unknown): MockError => { try { fn(); } catch (e) { return e as MockError; } throw new Error('expected a refusal'); };
const doc = (id: string) => st.docs.find((d) => d.id === id)!;
const ents = (id: string) => st.journals.find((j) => j.docId === id)?.preview.entries ?? [];
/** One JV line: ONE of debit / credit, plus the filler fields the line model needs. */
const L = (code: string, debit: string, credit: string, extra: Partial<DocLine> = {}): DocLine =>
  ({ id: `jl-${++n}`, description: `รายการ ${code}`, qty: '1', unit: '', unitPrice: '0.00', taxCode: 'EX', accountCode: code, debit, credit, ...extra });
const pair = (dr: string, cr: string, amount = '1000.00') => [L(dr, amount, '0.00'), L(cr, '0.00', amount)];
const draft = (lines: DocLine[], header: Record<string, unknown> = {}, co = CO) =>
  createDraft(st, co, 'JV', { header: { documentDate: '2026-10-10', ...header }, lines }, ME, `k${++n}`);
const post = (lines: DocLine[], header: Record<string, unknown> = {}, co = CO) => { const d = draft(lines, header, co); return issue(st, d.id, d.version, ME); };
/** debit - credit (satang) of one account up to a date over the company's whole journal: the trial balance reader. */
const bal = (code: string, asOf: string): number => {
  const r = trialBalance(st, CO, { asOf, includeZero: 'true' }).rows.find((x) => x.cells.code === code);
  return r ? toSatang(r.cells.debit) - toSatang(r.cells.credit) : 0;
};
const closeMonth = (month: string) => { const p = st.periods.find((x) => x.companyId === CO && x.month === month)!; p.status = 'closed'; (p as { closedAt?: string }).closedAt = new Date(Date.now() + 60_000).toISOString(); }; // closed after everything the test has posted so far
const sig = (lines: { accountCode?: string; debit?: string; credit?: string }[]) => lines.map((l) => `${l.accountCode}|${l.debit}|${l.credit}`);
const swapped = (lines: DocLine[]) => lines.map((l) => ({ accountCode: l.accountCode, debit: l.credit, credit: l.debit }));
const reversalsOf = (id: string) => st.docs.filter((d) => d.type === 'JV' && d.header.reversalOf === id);

describe('JV money rules (ruling 4)', () => {
  it('a draft saves unbalanced; issue is refused with the difference and writes nothing', () => {
    const d = draft([L('5110', '1000.00', '0.00'), L('2120', '0.00', '900.00')]);
    expect(d.totals.total).toBe('1000.00');
    const before = { docs: st.docs.length, series: JSON.stringify(st.series) };
    const e = err(() => issue(st, d.id, d.version, ME));
    expect(e.code).toBe('doc.incomplete');
    expect(e.title).toContain('ยอดเดบิตและเครดิตไม่เท่ากัน (ต่าง 100.00)');
    expect(st.docs.length).toBe(before.docs);
    expect(JSON.stringify(st.series)).toBe(before.series);
    expect(doc(d.id).status).toBe('draft');
    expect(ents(d.id)).toHaveLength(0);
  });
  it('a line needs an account and exactly one side', () => {
    const noAcct = draft([L('', '10.00', '0.00'), L('2120', '0.00', '10.00')]);
    expect(err(() => issue(st, noAcct.id, noAcct.version, ME)).title).toContain('ต้องเลือกบัญชี');
    const both = draft([L('5110', '10.00', '10.00'), L('2120', '0.00', '0.00')]);
    expect(err(() => issue(st, both.id, both.version, ME)).code).toBe('doc.incomplete');
  });
  it('issued: the journal is exactly its lines, with postedAt; invariants hold', () => {
    const lines = [L('5110', '4500.00', '0.00'), L('5160', '0.00', '1500.00'), L('2120', '0.00', '3000.00')];
    const d = post(lines);
    expect(d.number).toMatch(/^JV-202610-\d{4}$/);
    const e = ents(d.id);
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({ kind: 'original', date: '2026-10-10' });
    expect(e[0].postedAt).toBeTruthy();
    expect(sig(e[0].lines)).toEqual(sig(lines));
    expect(e[0].lines[0].accountName).toBe('ค่าเช่า');
    expect(checkInvariants(st)).toEqual([]);
  });
  it('a controlled account is refused at issue with the exit naming the document / screen, and compute reports it', () => {
    const exits: Record<string, string> = { '1130': 'ใบเสร็จ', '2110': 'ใบสำคัญจ่าย', '2180': 'ใบสำคัญจ่าย', '2140': 'ใบเสร็จ', '1140': 'ใบสำคัญจ่าย',
      '1170': 'ภาษี', '1171': 'ภาษี', '1180': 'ภาษี', '2131': 'ภาษี', '2132': 'ภาษี', '2133': 'ภาษี', '2134': 'ภาษี', '2135': 'ภาษี', '2151': 'ภาษี', '2152': 'ภาษี',
      '1110': 'รายการเดินบัญชี', '1120': 'รายการเดินบัญชี', '1121': 'รายการเดินบัญชี', '1122': 'รายการเดินบัญชี', '1123': 'รายการเดินบัญชี',
      '1210': 'ทะเบียนสินทรัพย์', '1211': 'ทะเบียนสินทรัพย์', '1220': 'ทะเบียนสินทรัพย์', '1221': 'ทะเบียนสินทรัพย์', '3900': 'ยอดยกมา' };
    for (const [code, hint] of Object.entries(exits)) {
      const d = draft(pair(code, '2120'));
      const e = err(() => issue(st, d.id, d.version, ME));
      expect(e.code, code).toBe('ledger.control_account');
      expect(e.title, code).toContain(hint);
      const c = compute(st, CO, 'JV', { header: d.header, lines: d.lines });
      expect(c.missing.some((m) => m.code === 'ledger.control_account'), code).toBe(true);
    }
    expect(checkInvariants(st)).toEqual([]);
  });
  it('accounts that are free for a JV post (expense, accrual, equity, revenue, prepaid)', () => {
    for (const code of ['5110', '5160', '5120', '2120', '3100', '3200', '4100', '1150']) {
      const d = post(pair(code, code === '5110' ? '2120' : '5110'));
      expect(d.status, code).toBe('issued');
    }
    expect(checkInvariants(st)).toEqual([]);
  });
  it('payroll payables 2160 and 2170 belong to the payroll run: a JV is refused with the payroll exit', () => {
    for (const code of ['2160', '2170']) {
      const d = draft(pair(code, '5110'));
      const c = err(() => issue(st, d.id, d.version, ME));
      expect(c.code, code).toBe('ledger.control_account');
      expect(c.title, code).toContain('รอบเงินเดือน');
    }
  });
  it('a JV line with a party keeps the journal = its lines invariant clean (F1)', () => {
    const p = st.parties.find((x) => x.companyId === CO)!;
    const d = post([L('5110', '1000.00', '0.00', { partyId: p.id }), L('2120', '0.00', '1000.00')]);
    expect(d.status).toBe('issued');
    expect(checkInvariants(st)).toEqual([]);
  });
  it('renaming the party after posting keeps the journal = its lines invariant clean (review F1b)', () => {
    const p = st.parties.find((x) => x.companyId === CO)!;
    post([L('5110', '1000.00', '0.00', { partyId: p.id }), L('2120', '0.00', '1000.00')]);
    p.name = `${p.name} (เปลี่ยนชื่อ)`;
    expect(checkInvariants(st)).toEqual([]);
  });
  it('an unknown or non-postable account is refused: ledger.account_invalid', () => {
    for (const code of ['9999', '5000']) {
      const d = draft(pair(code, '2120'));
      expect(err(() => issue(st, d.id, d.version, ME)).code, code).toBe('ledger.account_invalid');
    }
  });
  it("another company's account is not its own (company-owned)", () => {
    st.accounts = st.accounts.filter((a) => !(a.companyId === 'co-nonvat' && a.code === '5160'));
    const d = draft(pair('5160', '2120'), {}, 'co-nonvat');
    expect(err(() => issue(st, d.id, d.version, ME)).code).toBe('ledger.account_invalid');
  });
  it('a closed month and a future date are refused for a user JV', () => {
    const a = draft(pair('5110', '2120'), { documentDate: '2026-03-10' });
    expect(err(() => issue(st, a.id, a.version, ME)).code).toBe('period.closed');
    const b = draft(pair('5110', '2120'), { documentDate: '2026-10-20' });
    expect(err(() => issue(st, b.id, b.version, ME)).code).toBe('doc.future_date');
  });
  it('revise reverses and reposts (L-class); the GL follows the new lines', () => {
    const before = [bal('5110', TODAY), bal('5160', TODAY)];
    const d = post(pair('5110', '2120', '1000.00'));
    revise(st, d.id, { header: doc(d.id).header, lines: pair('5160', '2120', '700.00') }, doc(d.id).version, 'แก้ไขยอด', ME);
    const e = ents(d.id);
    expect(e.map((x) => x.kind)).toEqual(['original', 'reversal', 'correction']);
    expect(e.every((x) => !!x.postedAt)).toBe(true);
    expect(sig(e[2].lines)).toEqual(sig(doc(d.id).lines));
    expect(bal('5110', TODAY)).toBe(before[0]);
    expect(bal('5160', TODAY) - before[1]).toBe(70000);
    expect(checkInvariants(st)).toEqual([]);
  });
  it('cancel reverses the entry', () => {
    const before = bal('5110', TODAY);
    const d = post(pair('5110', '2120', '800.00'));
    expect(bal('5110', TODAY) - before).toBe(80000);
    cancel(st, d.id, doc(d.id).version, 'OTHER', 'ผิดบัญชี', ME);
    expect(bal('5110', TODAY)).toBe(before);
    expect(checkInvariants(st)).toEqual([]);
  });
});

describe('กลับรายการ (reverse): JV only (ruling 2)', () => {
  it('reverses a JV: dated max(original, first open date), mirrored lines, linked adjusts, postedAt, nets to zero', () => {
    const o = post(pair('5110', '5160', '2500.00'), { documentDate: '2026-10-02' });
    const before = bal('5110', TODAY);
    const r = reverseJv(st, o.id, ME);
    const rd = doc(r.id);
    expect(rd).toMatchObject({ type: 'JV', status: 'issued' });
    expect(rd.header).toMatchObject({ documentDate: '2026-10-02', reversalOf: o.id });
    expect(rd.number).toMatch(/^JV-/);
    expect(sig(rd.lines)).toEqual(sig(swapped(doc(o.id).lines)));
    expect(ents(r.id)[0].postedAt).toBeTruthy();
    expect(st.links.filter((l) => l.active && l.kind === 'adjusts' && l.from === r.id && l.to === o.id)).toHaveLength(1);
    expect(bal('5110', TODAY) - before).toBe(-250000);
    expect(checkInvariants(st)).toEqual([]);
  });
  it('an original in a closed month is reversed on the first open date', () => {
    const o = post(pair('5110', '5160'), { documentDate: '2026-09-20' });
    closeMonth('2026-09');
    const r = reverseJv(st, o.id, ME);
    expect(doc(r.id).header.documentDate).toBe('2026-10-01');
    expect(checkInvariants(st)).toEqual([]);
  });
  it('the user may pick a later open date, not an earlier one, not a future one', () => {
    const o = post(pair('5110', '5160'), { documentDate: '2026-10-02' });
    expect(err(() => reverseJv(st, o.id, ME, { date: '2026-10-01' })).code).toBe('ledger.reverse_date');
    expect(err(() => reverseJv(st, o.id, ME, { date: '2026-10-20' })).code).toBe('doc.future_date');
    const r = reverseJv(st, o.id, ME, { date: '2026-10-12', reason: 'ลงผิดงวด' });
    expect(doc(r.id).header.documentDate).toBe('2026-10-12');
  });
  it('a JV is reversed once; the reversed JV is final (no revise, no cancel); the reversal cannot be revised or cancelled', () => {
    const o = post(pair('5110', '5160'));
    const r = reverseJv(st, o.id, ME);
    expect(err(() => reverseJv(st, o.id, ME)).code).toBe('ledger.already_reversed');
    expect(err(() => revise(st, o.id, { header: doc(o.id).header, lines: pair('5110', '5160', '5.00') }, doc(o.id).version, 'x', ME)).code).toBe('ledger.reversed_final');
    expect(err(() => cancel(st, o.id, doc(o.id).version, 'OTHER', 'x', ME)).code).toBe('ledger.reversed_final');
    expect(err(() => revise(st, r.id, { header: doc(r.id).header, lines: doc(r.id).lines }, doc(r.id).version, 'x', ME)).code).toBe('ledger.reversal_final');
    expect(err(() => cancel(st, r.id, doc(r.id).version, 'OTHER', 'x', ME)).code).toBe('ledger.reversal_final');
    expect(derivedLocks(st, doc(o.id)).some((l) => l.kind === 'reversal')).toBe(true);
  });
  it('a reversal JV made by a person reads locked too, with the exit "กลับรายการใบนี้"; once reversed it has no exit (M3)', () => {
    const o = post(pair('5110', '5160'));
    const r = reverseJv(st, o.id, ME);
    const lock = derivedLocks(st, doc(r.id)).find((l) => l.kind === 'reversal')!;
    expect(lock.exits).toEqual(['กลับรายการใบนี้']);
    expect(lock.reason).toContain(doc(o.id).number!);
    reverseJv(st, r.id, ME);
    expect(derivedLocks(st, doc(r.id)).find((l) => l.kind === 'reversal')!.exits).toEqual([]);
  });
  it('a reversed JV in a closed month reads with ONE banner: the reversal-final lock replaces the period lock (M1)', () => {
    const o = post(pair('5110', '5160'), { documentDate: '2026-09-20' });
    closeMonth('2026-09');
    expect(derivedLocks(st, doc(o.id)).map((l) => l.kind)).toEqual(['period']);
    reverseJv(st, o.id, ME);
    expect(derivedLocks(st, doc(o.id)).map((l) => l.kind)).toEqual(['reversal']);
  });
  it('a reversal can itself be reversed once (re-instates the entry)', () => {
    const o = post(pair('5110', '5160', '300.00'));
    const before = bal('5110', TODAY);
    const r = reverseJv(st, o.id, ME);
    const rr = reverseJv(st, r.id, ME);
    expect(bal('5110', TODAY)).toBe(before);
    expect(doc(rr.id).header.reversalOf).toBe(r.id);
    expect(checkInvariants(st)).toEqual([]);
  });
  it('a document entry (TI) is refused: ledger.reverse_document with the exit', () => {
    const ti = st.docs.find((d) => d.type === 'TI' && d.status === 'issued' && d.companyId === CO)!;
    const e = err(() => reverseJv(st, ti.id, ME));
    expect(e.code).toBe('ledger.reverse_document');
    expect(e.title).toContain(`ยกเลิกหรือแก้ไขเอกสาร ${ti.number}`);
    expect(ents(ti.id)).toHaveLength(1);
  });
  it('a draft JV cannot be reversed', () => {
    const d = draft(pair('5110', '5160'));
    expect(err(() => reverseJv(st, d.id, ME)).code).toBe('doc.not_reversible');
  });
});

describe('auto-reverse accruals (ruling 3)', () => {
  const accrual = (amount = '5000.00', date = '2026-10-10') => post(pair('5120', '2120', amount), { documentDate: date, autoReverse: true });
  it('issue creates the system reversal on day 1 of the next month, mirrored, linked, nets to zero', () => {
    const before = bal('5120', '2026-12-31');
    const a = accrual();
    const r = reversalsOf(a.id)[0];
    expect(r.header).toMatchObject({ documentDate: '2026-11-01', autoReversal: true, reversalOf: a.id });
    expect(r.status).toBe('issued');
    expect(sig(r.lines)).toEqual(sig(swapped(doc(a.id).lines)));
    expect(ents(r.id)[0].postedAt).toBeTruthy();
    expect(st.links.filter((l) => l.active && l.kind === 'adjusts' && l.from === r.id && l.to === a.id)).toHaveLength(1);
    expect(bal('5120', TODAY) - before).toBe(500000); // the reversal is not effective yet
    expect(bal('5120', '2026-12-31') - before).toBe(0);
    expect(checkInvariants(st)).toEqual([]);
  });
  it('a reversed accrual cannot be reversed again by hand; the system reversal cannot be revised or cancelled alone', () => {
    const a = accrual();
    const r = reversalsOf(a.id)[0];
    expect(err(() => reverseJv(st, a.id, ME)).code).toBe('ledger.already_reversed');
    expect(err(() => reverseJv(st, r.id, ME)).code).toBe('ledger.reverse_document');
    expect(err(() => cancel(st, r.id, r.version, 'OTHER', 'x', ME)).code).toBe('ledger.reversal_final');
    expect(err(() => revise(st, r.id, { header: r.header, lines: r.lines }, r.version, 'x', ME)).code).toBe('ledger.reversal_final');
  });
  it('revising the accrual revises its pending reversal; the pair still nets to zero', () => {
    const before = bal('5120', '2026-12-31');
    const a = accrual('5000.00');
    const r0 = reversalsOf(a.id)[0];
    revise(st, a.id, { header: doc(a.id).header, lines: pair('5120', '2120', '7200.00') }, doc(a.id).version, 'ปรับยอด', ME);
    const r = doc(r0.id);
    expect(r.status).toBe('issued');
    expect(r.totals.total).toBe('7200.00');
    expect(sig(r.lines)).toEqual(sig(swapped(doc(a.id).lines)));
    expect(bal('5120', '2026-12-31') - before).toBe(0);
    expect(reversalsOf(a.id).filter((d) => d.status === 'issued')).toHaveLength(1);
    expect(checkInvariants(st)).toEqual([]);
  });
  it('turning autoReverse off cancels the pending reversal; turning it on creates it', () => {
    const a = accrual();
    revise(st, a.id, { header: { ...doc(a.id).header, autoReverse: false }, lines: doc(a.id).lines }, doc(a.id).version, 'ไม่กลับรายการ', ME);
    expect(reversalsOf(a.id).filter((d) => d.status === 'issued')).toHaveLength(0);
    expect(checkInvariants(st)).toEqual([]);
    revise(st, a.id, { header: { ...doc(a.id).header, autoReverse: true }, lines: doc(a.id).lines }, doc(a.id).version, 'กลับรายการ', ME);
    expect(reversalsOf(a.id).filter((d) => d.status === 'issued')).toHaveLength(1);
    expect(checkInvariants(st)).toEqual([]);
  });
  it('cancelling the accrual cancels its pending reversal; nothing is left in the GL at any date', () => {
    const base = ['5120', '2120'].map((c) => [bal(c, TODAY), bal(c, '2026-12-31')]);
    const a = accrual();
    cancel(st, a.id, doc(a.id).version, 'OTHER', 'ยกเลิกรายการค้างจ่าย', ME);
    expect(reversalsOf(a.id).every((d) => d.status === 'cancelled')).toBe(true);
    expect(['5120', '2120'].map((c) => [bal(c, TODAY), bal(c, '2026-12-31')])).toEqual(base);
    expect(checkInvariants(st)).toEqual([]);
  });
  it('refused when the next month is closed: nothing is written', () => {
    closeMonth('2026-11');
    const d = draft(pair('5120', '2120'), { autoReverse: true });
    const snap = { docs: st.docs.length, series: JSON.stringify(st.series), journals: st.journals.length };
    expect(err(() => issue(st, d.id, d.version, ME)).code).toBe('ledger.auto_reverse_closed');
    expect({ docs: st.docs.length, series: JSON.stringify(st.series), journals: st.journals.length }).toEqual(snap);
  });
});

describe('invariants report a tampered JV state (can fail)', () => {
  const msgs = () => checkInvariants(st).join('\n');
  it('a JV line on a controlled account', () => {
    const d = post(pair('5110', '5160'));
    doc(d.id).lines[0].accountCode = '1130';
    ents(d.id)[0].lines[0].accountCode = '1130';
    expect(msgs()).toMatch(new RegExp(`${d.id}.*1130`));
  });
  it('a journal that is not its lines', () => {
    const d = post(pair('5110', '5160', '100.00'));
    doc(d.id).lines[0].debit = '90.00';
    expect(msgs()).toMatch(new RegExp(`${d.id}.*lines`));
  });
  it('a reversal that is not the mirror of its original', () => {
    const o = post(pair('5110', '5160', '100.00'));
    const r = reverseJv(st, o.id, ME);
    doc(r.id).lines[0].debit = '99.00';
    ents(r.id)[0].lines[0].debit = '99.00';
    expect(msgs()).toMatch(new RegExp(`${r.id}.*mirror`));
  });
  it('an accrual whose auto-reversal is missing', () => {
    const a = post(pair('5120', '2120'), { autoReverse: true });
    reversalsOf(a.id)[0].status = 'cancelled';
    expect(msgs()).toMatch(new RegExp(`${a.id}.*auto-reversal`));
  });
});

describe('the general journal (ruling 5)', () => {
  it('lists every entry of the company: documents, JV, settlements, bank journals; balanced; each with its source link', () => {
    post(pair('5110', '5160', '123.00'));
    const m = generalJournal(st, CO, {});
    expect(m.kind).toBe('general-journal');
    expect(m.tieOuts![0].diff).toBe('0.00');
    const hrefs = m.rows.filter((r) => r.kind === 'group').map((r) => r.href ?? '');
    expect(hrefs.some((h) => h.startsWith('/accounting/journal-vouchers/'))).toBe(true);
    expect(hrefs.some((h) => h.startsWith('/sales/tax-invoices/'))).toBe(true);
    expect(hrefs.some((h) => h.startsWith('/finance/settlements/'))).toBe(true);
    expect(hrefs.some((h) => h.startsWith('/finance/bank-accounts/'))).toBe(true);
  });
  it('filters by date range, account and source type', () => {
    post(pair('5110', '5160', '321.00'), { documentDate: '2026-10-09' });
    const acct = generalJournal(st, CO, { account: '5160' });
    expect(acct.rows.filter((r) => r.kind === 'row').every((r) => r.cells.entry.startsWith('5160'))).toBe(true);
    expect(acct.rows.length).toBeGreaterThan(0);
    const jv = generalJournal(st, CO, { source: 'JV' });
    expect(jv.rows.filter((r) => r.kind === 'group').every((r) => (r.href ?? '').startsWith('/accounting/journal-vouchers/'))).toBe(true);
    expect(jv.rows.length).toBeGreaterThan(0);
    const day = generalJournal(st, CO, { from: '2026-10-09', to: '2026-10-09' });
    expect(day.rows.filter((r) => r.kind === 'group').every((r) => r.cells.date === '2026-10-09')).toBe(true);
    expect(day.rows.length).toBeGreaterThan(0);
    const stl = generalJournal(st, CO, { source: 'STL' });
    expect(stl.rows.some((r) => (r.href ?? '').startsWith('/finance/settlements/'))).toBe(true);
    expect(stl.rows.filter((r) => r.kind === 'group').every((r) => (r.href ?? '').startsWith('/finance/settlements/'))).toBe(true);
  });
});

describe('permissions: JV is accountant-only (§3.1)', () => {
  it('the accountant holds every doc.JV.* right; operator and admin hold none', () => {
    for (const v of ['read', 'create', 'issue', 'cancel', 'correct', 'approve']) expect(PERMISSIONS_BY_ROLE.accountant).toContain(`doc.JV.${v}`);
    for (const r of ['operator', 'admin'] as const) expect(PERMISSIONS_BY_ROLE[r].filter((p) => p.startsWith('doc.JV.'))).toEqual([]);
  });
});
