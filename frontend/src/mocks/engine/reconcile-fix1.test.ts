import { beforeEach, describe, expect, it } from 'vitest';
import type { Actor, BankJournal } from '@/domain/types';
import { buildSeedState, type MockState } from '../store';
import { NBANK_SEP_CSV } from '../fixtures/statements/kbiz-2026-10.csv';
import { importStatement, utf8Base64 } from './bank-import';
import { correctionPlan, executePlan } from './corrections';
import { checkInvariants } from './invariants';
import type { MockError } from './log';
import { fromSatang } from './money';
import { ensureDimensions } from './posting';
import { glBalance, ignore, linesOf, lockTo, match, post, reverseTransfer, suggest, transfer, unmatch } from './reconcile';
import { bankReconciliation } from './reports/bank-reconciliation';

const ME: Actor = { kind: 'user', id: 'u-1', name: 'สมศรี บัญชีดี' };
const CO = 'co-vat', ACC = 'ba-kbank';
let st: MockState;
beforeEach(() => { localStorage.clear(); st = buildSeedState(); });

const err = (fn: () => unknown): MockError => { try { fn(); } catch (e) { return e as MockError; } throw new Error('expected a refusal'); };
const line = (id: string) => st.bankLines.find((l) => l.id === id)!;
const tie = (co: string, acc: string, to: string) => bankReconciliation(st, co, { account: acc, to }).tieOuts![0].diff;
const addLine = (id: string, date: string, amount: string, accountId = ACC, balance = '0.00', companyId = CO): string => {
  st.bankLines.push({ companyId, id, accountId, importId: 'bi-001', date, description: 'ทดสอบ', amount, balance, status: 'unmatched' });
  return id;
};
const bankJournal = (co: string, accountId: string, bankCode: string, otherCode: string, partyName?: string): BankJournal => ({
  id: 'bj-tamper', companyId: co, accountId, kind: 'inline', label: 'tamper',
  entries: [{ date: '2026-09-10', kind: 'original', postedAt: '2026-09-10T10:00:00+07:00', lines: [
    { accountCode: bankCode, accountName: 'bank', debit: '100.00', credit: '0.00', rule: 'x' },
    { accountCode: otherCode, accountName: 'other', debit: '0.00', credit: '100.00', rule: 'x', ...(partyName ? { partyName } : {}) },
  ] }],
});

describe('R0: bank journals feed every GL invariant', () => {
  it.each([['1130', 'AR'], ['2110', 'AP'], ['2180', 'employee'], ['1180', 'WHT receivable'], ['2131', 'WHT payable'], ['1170', 'input VAT']])(
    'a tampered bank journal on %s (%s) is reported', (code) => {
      expect(checkInvariants(st)).toEqual([]);
      st.bankJournals.push(bankJournal(CO, ACC, '1121', code, 'ลูกค้า'));
      expect(checkInvariants(st).join('\n')).toContain(code);
    });
  it('1170 of a company outside VAT', () => {
    st.bankJournals.push(bankJournal('co-nonvat', 'nba-kbank', '1121', '1170'));
    expect(checkInvariants(st).join('\n')).toMatch(/not VAT-registered but GL 1170/);
  });
});

describe('I1: an inline journal posts only to uncontrolled accounts', () => {
  const refused = ['1130', '2110', '2180', '2140', '1140', '1171', '2152', '2153', '2160', '2170', '2131', '1170', '1180', '2151', '1122', '1110', '1120', '3100', '3200', '3900'];
  it.each(refused)('%s is refused with ledger.control_account and writes nothing', (code) => {
    const n = st.bankJournals.length;
    const e = err(() => post(st, CO, 'bi-001-017', { accountCode: code }, ME));
    expect(e.code).toBe('ledger.control_account');
    expect(st.bankJournals).toHaveLength(n);
    expect(line('bi-001-017').status).toBe('unmatched');
  });
  it('the refusal names the document to use', () => {
    expect(err(() => post(st, CO, 'bi-001-017', { accountCode: '2180' }, ME)).title).toMatch(/ใบสำคัญจ่าย/);
    expect(err(() => post(st, CO, 'bi-001-017', { accountCode: '1122' }, ME)).title).toMatch(/โอนระหว่างบัญชี/);
  });
  it.each(['5200', '4200', '1150', '2120', '5110'])('%s (P&L / uncontrolled balance sheet) is allowed', (code) => {
    expect(post(st, CO, 'bi-001-017', { accountCode: code }, ME).status).toBe('posted');
    expect(checkInvariants(st)).toEqual([]);
  });
});

describe('I2: transfers between own accounts', () => {
  const OUT = 'bi-001-001'; // -35,000 on kbank
  const glSum = () => glBalance(st, CO, '1121', '2026-12-31') + glBalance(st, CO, '1122', '2026-12-31');
  /** the SCB statement shows the money arriving: closing = its GL once the transfer is booked */
  const scbLine = () => {
    const d = line(OUT).date;
    return addLine('scb-1', d, '35000.00', 'ba-scb', fromSatang(glBalance(st, CO, '1122', d)));
  };
  it('one journal Dr receiving / Cr paying at the line date; the paying line is matched; GL counts the money once', () => {
    const before = glSum();
    const l = transfer(st, CO, OUT, 'ba-scb', ME);
    expect(l.status).toBe('matched');
    const j = st.bankJournals.find((x) => x.kind === 'transfer')!;
    expect(j.entries[0]).toMatchObject({ date: line(OUT).date, kind: 'original' });
    expect(j.entries[0].lines.map((g) => [g.accountCode, g.debit, g.credit])).toEqual([['1121', '0.00', '35000.00'], ['1122', '35000.00', '0.00']]);
    expect(glSum()).toBe(before); // moved, not created
    expect(tie(CO, ACC, '2026-10-15')).toBe('0.00');
    expect(checkInvariants(st)).toEqual([]);
  });
  it('the receiving line is suggested the journal (same amount, +-7 days), matches it, and both ties are 0.00', () => {
    transfer(st, CO, OUT, 'ba-scb', ME);
    const id = scbLine();
    const s = suggest(st, CO, id);
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ type: 'TR', exact: true, cash: '35000.00' });
    expect(tie(CO, 'ba-scb', '2026-10-15')).toBe('0.00'); // in transit: the journal is a reconciling item
    expect(bankReconciliation(st, CO, { account: 'ba-scb', to: '2026-10-15' }).rows.some((r) => r.cells.item?.includes('โอน'))).toBe(true);
    const m = match(st, CO, id, { docIds: [s[0].docId] }, ME);
    expect(m.status).toBe('matched');
    expect(tie(CO, 'ba-scb', '2026-10-15')).toBe('0.00');
    expect(tie(CO, ACC, '2026-10-15')).toBe('0.00');
    expect(checkInvariants(st)).toEqual([]);
  });
  it('a different amount, a far date or the wrong direction is not suggested', () => {
    transfer(st, CO, OUT, 'ba-scb', ME);
    expect(suggest(st, CO, addLine('s-amt', line(OUT).date, '34999.00', 'ba-scb'))).toEqual([]);
    expect(suggest(st, CO, addLine('s-far', '2026-12-01', '35000.00', 'ba-scb'))).toEqual([]);
    expect(suggest(st, CO, addLine('s-dir', line(OUT).date, '-35000.00', 'ba-scb'))).toEqual([]);
  });
  it('unmatching the paying side while the receiving side is matched is refused; each side unmatches on its own and the journal stays', () => {
    transfer(st, CO, OUT, 'ba-scb', ME);
    const id = scbLine();
    match(st, CO, id, { docIds: [suggest(st, CO, id)[0].docId] }, ME);
    const e = err(() => unmatch(st, CO, OUT, ME));
    expect(e.code).toBe('bank.transfer_matched');
    expect(e.title).toMatch(/ยกเลิกการจับคู่/);
    expect(line(OUT).status).toBe('matched');
    const glNow = glSum();
    unmatch(st, CO, id, ME); // receiving first
    unmatch(st, CO, OUT, ME);
    const j = st.bankJournals.find((x) => x.kind === 'transfer')!;
    expect(j.entries).toHaveLength(1);
    expect(glSum()).toBe(glNow);
    expect(tie(CO, ACC, '2026-10-15')).toBe('0.00');
    expect(tie(CO, 'ba-scb', '2026-10-15')).toBe('0.00');
    expect(checkInvariants(st)).toEqual([]);
  });
  it('a paying line whose journal is kept cannot be booked again (no double count); transfer re-attaches the same journal', () => {
    transfer(st, CO, OUT, 'ba-scb', ME);
    unmatch(st, CO, OUT, ME);
    expect(err(() => post(st, CO, OUT, { accountCode: '5200' }, ME)).code).toBe('bank.transfer_pending');
    expect(err(() => match(st, CO, OUT, { docIds: ['pv-pay1'] }, ME)).code).toBe('bank.transfer_pending');
    const n = st.bankJournals.length, sum = glSum();
    expect(transfer(st, CO, OUT, 'ba-scb', ME).status).toBe('matched');
    expect(st.bankJournals).toHaveLength(n);
    expect(glSum()).toBe(sum);
  });
  it('reversing the journal needs both sides unmatched; then it is reversed once and the lines are free', () => {
    transfer(st, CO, OUT, 'ba-scb', ME);
    const j = st.bankJournals.find((x) => x.kind === 'transfer')!;
    expect(err(() => reverseTransfer(st, CO, j.id, ME, 'ทดสอบ')).code).toBe('bank.transfer_matched');
    unmatch(st, CO, OUT, ME);
    const before = glSum();
    reverseTransfer(st, CO, j.id, ME, 'ทดสอบ');
    expect(j.entries.map((e) => e.kind)).toEqual(['original', 'reversal']);
    expect(glBalance(st, CO, '1121', '2026-12-31') - before).toBe(0);
    expect(glSum()).toBe(before);
    expect(err(() => reverseTransfer(st, CO, j.id, ME, 'ทดสอบ')).code).toBe('bank.transfer_reversed');
    expect(post(st, CO, OUT, { accountCode: '5200' }, ME).status).toBe('posted'); // free again
    expect(suggest(st, CO, addLine('s-rev', line(OUT).date, '35000.00', 'ba-scb'))).toEqual([]);
    expect(checkInvariants(st)).toEqual([]);
  });
  it('a receiving-side line can start the transfer too (signs follow the line)', () => {
    const d = line(OUT).date;
    const inc = addLine('scb-in', d, '1000.00', 'ba-scb');
    transfer(st, CO, inc, ACC, ME);
    const j = st.bankJournals.find((x) => x.kind === 'transfer')!;
    expect(j.entries[0].lines.map((g) => [g.accountCode, g.debit, g.credit])).toEqual([['1122', '1000.00', '0.00'], ['1121', '0.00', '1000.00']]);
    expect(checkInvariants(st)).toEqual([]);
  });
  it('refuses the same account, an inactive account, another company, a line that is not unmatched; writes nothing', () => {
    const n = st.bankJournals.length;
    expect(err(() => transfer(st, CO, OUT, ACC, ME)).code).toBe('bank.transfer_same_account');
    expect(err(() => transfer(st, CO, OUT, 'nba-kbank', ME)).code).toBe('record.not_found');
    st.bankAccounts.find((b) => b.id === 'ba-scb')!.active = false;
    expect(err(() => transfer(st, CO, OUT, 'ba-scb', ME)).code).toBe('bank.transfer_inactive');
    st.bankAccounts.find((b) => b.id === 'ba-scb')!.active = true;
    ignore(st, CO, OUT, ME);
    expect(err(() => transfer(st, CO, OUT, 'ba-scb', ME)).code).toBe('bank.line_state');
    expect(st.bankJournals).toHaveLength(n);
  });
});

describe('I3: no import into a reconciled range', () => {
  it('an import with a line on or before reconciledTo is refused 422 bank.import_locked_period, naming the date', () => {
    const co = 'co-nonvat', acc = 'nba-kbank';
    for (const l of linesOf(st, co, acc)) if (l.status === 'unmatched') { const s = suggest(st, co, l.id); if (s.length) match(st, co, l.id, { docIds: [s[0].docId] }, ME); else ignore(st, co, l.id, ME, 'x'); }
    const last = linesOf(st, co, acc).map((l) => l.date).sort().at(-1)!;
    lockTo(st, co, acc, last, ME);
    const lines = st.bankLines.length, imports = st.bankImports.length;
    const e = err(() => importStatement(st, co, acc, { fileName: 'again.csv', format: 'kbiz-csv', content: utf8Base64(`${NBANK_SEP_CSV}\n`) }, ME));
    expect(e.status).toBe(422);
    expect(e.code).toBe('bank.import_locked_period');
    expect(e.title).toMatch(/2569/); // the date, in the Buddhist era
    expect(st.bankLines).toHaveLength(lines);
    expect(st.bankImports).toHaveLength(imports);
  });
});

describe('I4: the seed goes live at the statement', () => {
  it.each([[CO, 'ba-kbank'], ['co-nonvat', 'nba-kbank']])('%s %s: GL on the day before the first line = the statement opening; the report ties out to 0.00 and lists no pre-go-live receipt', (co, acc) => {
    const imp = st.bankImports.find((i) => i.companyId === co && i.accountId === acc)!;
    const bank = st.bankAccounts.find((b) => b.id === acc)!;
    const dayBefore = new Date(Date.parse(`${imp.from}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    expect(fromSatang(glBalance(st, co, bank.accountCode, dayBefore))).toBe(imp.opening);
    const j = st.bankJournals.find((x) => x.companyId === co && x.kind === 'opening')!;
    expect(j.label).toBe('ปรับยอดยกมาตาม statement');
    const rep = bankReconciliation(st, co, { account: acc, to: '2026-10-15' });
    expect(rep.tieOuts![0].diff).toBe('0.00');
    const dated = rep.rows.filter((r) => r.kind === 'row' && r.cells.date && /^(RC|PV) /.test(r.cells.item ?? ''));
    expect(dated.length).toBeGreaterThan(0);
    for (const r of dated) expect(r.cells.date >= imp.from).toBe(true);
    expect(checkInvariants(st)).toEqual([]);
  });
  it('suggestions and search consider only documents dated on or after the go-live; history cannot be matched', () => {
    const far = addLine('x-far', '2026-09-30', '6955.00');
    const all = suggest(st, CO, far, 'RC-').map((c) => c.documentDate);
    expect(all.length).toBeGreaterThan(0);
    for (const d of all) expect(d >= '2026-09-01').toBe(true);
    const old = st.docs.find((d) => d.companyId === CO && d.type === 'RC' && d.status === 'issued' && d.header.documentDate < '2026-09-01' && (d.header.bankAccountId ?? ACC) === ACC)!;
    expect(err(() => match(st, CO, addLine('x-old', '2026-09-30', old.totals.cash ?? '1.00'), { docIds: [old.id] }, ME)).code).toBe('bank.match_history');
  });
});

describe('minors', () => {
  it('M1: a receipt dated after the line it matched stays under deposits in transit (negative), not under outstanding payments', () => {
    const early = addLine('x-early', '2026-09-01', '6955.00', ACC, '306955.00'); // the bank shows it on the 1st (opening 300,000 + 6,955), the receipt is dated the 5th
    match(st, CO, early, { docIds: ['rc-013'] }, ME);
    const r = bankReconciliation(st, CO, { account: ACC, to: '2026-09-01' });
    const i = r.rows.findIndex((x) => x.cells.item?.includes('RC-202609-0001'));
    expect(i).toBeGreaterThan(0);
    expect(r.rows.slice(0, i).reverse().find((x) => x.kind === 'group')?.cells.item).toMatch(/เงินรับระหว่างทาง/);
    expect(r.rows[i].cells.amount.startsWith('-')).toBe(true);
    expect(r.tieOuts![0].diff).toBe('0.00');
  });
  it('M2: lockTo validates a real calendar date', () => {
    expect(err(() => lockTo(st, 'co-nonvat', 'nba-kbank', '2026-02-30', ME)).code).toBe('bank.lock_date');
    expect(err(() => lockTo(st, 'co-nonvat', 'nba-kbank', '2026-13-01', ME)).code).toBe('bank.lock_date');
  });
  it('M3: a rounding difference above 1.00 is refused', () => {
    const id = addLine('x-round', '2026-09-05', '6957.50');
    const e = err(() => match(st, CO, id, { docIds: ['rc-013'], diff: { role: 'RoundingDifference', amount: '2.50' } }, ME));
    expect(e.code).toBe('bank.rounding_too_large');
    expect(match(st, CO, addLine('x-round2', '2026-09-05', '6955.80'), { docIds: ['rc-013'], diff: { role: 'RoundingDifference', amount: '0.80' } }, ME).status).toBe('matched');
  });
  it('M4: inline-journal dimensions must come from the company dimension MASTER (not from what documents carry)', () => {
    const d0 = st.docs.find((d) => d.companyId === CO && d.type === 'TI')!;
    d0.header = { ...d0.header, dimensions: { project: 'P-1' } }; // a document carrying a value the master lacks does not make it known
    expect(err(() => post(st, CO, 'bi-001-017', { accountCode: '5200', dimensions: { project: 'P-1' } }, ME)).code).toBe('ledger.dimension_invalid');
    expect(err(() => post(st, CO, 'bi-001-017', { accountCode: '5200', dimensions: { project: 'NO-SUCH-VALUE' } }, ME)).code).toBe('ledger.dimension_invalid');
    expect(err(() => post(st, CO, 'bi-001-017', { accountCode: '5200', dimensions: { nokey: 'P-B' } }, ME)).code).toBe('ledger.dimension_invalid');
    // a master value no document carries is accepted; once deactivated it is refused
    expect(st.docs.some((d) => d.companyId === CO && [d.header.dimensions, ...d.lines.map((l) => l.dimensions)].some((m) => m?.department === 'D-03'))).toBe(false);
    ensureDimensions(st);
    st.dimensionValues!.find((x) => x.companyId === CO && x.code === 'D-03')!.active = false;
    expect(err(() => post(st, CO, 'bi-001-017', { accountCode: '5200', dimensions: { department: 'D-03' } }, ME)).code).toBe('ledger.dimension_invalid');
    st.dimensionValues!.find((x) => x.companyId === CO && x.code === 'D-03')!.active = true;
    expect(post(st, CO, 'bi-001-017', { accountCode: '5200', dimensions: { department: 'D-03' } }, ME).status).toBe('posted');
  });
  it('M5: the report says the line status is read as of now', () => {
    expect(bankReconciliation(st, CO, { account: ACC, to: '2026-09-30' }).notes).toContain('สถานะรายการอ่าน ณ ปัจจุบัน');
  });
  it('M7: a plan built before a match and executed after is refused with the reconciled reason, not plan-stale', () => {
    const rc = st.docs.find((d) => d.id === 'rc-013')!;
    const plan = correctionPlan(st, rc.id, { header: { ...rc.header, dimensions: { project: 'P-B' } }, lines: rc.lines, allocations: rc.allocations }, 'accountant');
    expect(plan.steps.length).toBeGreaterThan(0);
    match(st, CO, 'bi-001-003', { docIds: ['rc-013'] }, ME);
    const e = err(() => executePlan(st, plan.planId, plan.planHash, ME, 'accountant'));
    expect(e.code).toBe('doc.reconciled');
    expect(e.title).toMatch(/ยกเลิกการจับคู่/);
  });
});
