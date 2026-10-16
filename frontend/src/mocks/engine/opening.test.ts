import { beforeEach, describe, expect, it } from 'vitest';
import type { Actor, Allocation, DocLine, DocOpening } from '@/domain/types';
import { buildSeedState, type MockState } from '../store';
import { bankReconciliation } from './reports/bank-reconciliation';
import { cancel, compute, createDraft, issue, revise } from './commands';
import { correctionPlan, executePlan } from './corrections';
import { checkInvariants } from './invariants';
import { obInvariants } from './opening';
import { derivedLocks } from './locks';
import { toSatang } from './money';
import { match, suggest, unmatch } from './reconcile';
import { postSettlement } from './settlement-records';
import { trialBalance } from './reports/trial-balance';

const ME: Actor = { kind: 'user', id: 'u-1', name: 'สมศรี บัญชีดี' };
const CO = 'co-vat';
let st: MockState, n = 0;
beforeEach(() => { localStorage.clear(); st = buildSeedState(); });

const err = (fn: () => unknown): { code: string; title: string } => { try { fn(); } catch (e) { return e as { code: string; title: string }; } throw new Error('expected a refusal'); };
const doc = (id: string) => st.docs.find((d) => d.id === id)!;
const ents = (id: string) => st.journals.find((j) => j.docId === id)?.preview.entries ?? [];
const L = (code: string, debit: string, credit: string, extra: Partial<DocLine> = {}): DocLine =>
  ({ id: `ol-${++n}`, description: `ยอดยกมา ${code}`, qty: '1', unit: '', unitPrice: '0.00', taxCode: 'EX', accountCode: code, debit, credit, ...extra });
const OP = (over: Partial<DocOpening> = {}): DocOpening => ({ openItems: [], assets: [], payrollYtd: [], bank: [], ...over });
const draft = (lines: DocLine[], opening: DocOpening, date = '2026-06-30', header: Record<string, unknown> = {}) =>
  createDraft(st, CO, 'OB', { header: { documentDate: date, ...header }, lines, opening }, ME, `ob${++n}`);
const post = (lines: DocLine[], opening: DocOpening, date = '2026-06-30') => { const d = draft(lines, opening, date); return issue(st, d.id, d.version, ME); };
const AR = (partyId: string, amount: string, docNumber = `IV-${partyId}`) => ({ side: 'AR' as const, partyId, docNumber, docDate: '2026-05-01', dueDate: '2026-05-31', amount });
const AP = (partyId: string, amount: string, docNumber = `BILL-${partyId}`) => ({ side: 'AP' as const, partyId, docNumber, docDate: '2026-05-02', amount });
const sat = (m: string) => toSatang(m);
/** debit - credit (satang) of an account over the company's whole journal. */
const gl = (code: string): number => {
  const r = trialBalance(st, CO, { asOf: '2026-12-31', includeZero: 'true' }).rows.find((x) => x.cells.code === code);
  return r ? sat(r.cells.debit) - sat(r.cells.credit) : 0;
};
const rc = (partyId: string, allocations: Allocation[]) => {
  const d = createDraft(st, CO, 'RC', { header: { partyId, documentDate: '2026-10-14' }, lines: [], allocations }, ME, `rc${++n}`);
  return issue(st, d.id, d.version, ME);
};
const pv = (partyId: string, allocations: Allocation[]) => {
  const d = createDraft(st, CO, 'PV', { header: { partyId, documentDate: '2026-10-14' }, lines: [], allocations }, ME, `pv${++n}`);
  return issue(st, d.id, d.version, ME);
};
/** A basic opening: AR 1,500.00 (two customers), a plain accrual and a prepaid expense; 3900 takes the rest. */
const basic = () => post([L('1130', '1500.00', '0.00'), L('1150', '200.00', '0.00'), L('2120', '0.00', '300.00')], OP({ openItems: [AR('pc-01', '1000.00'), AR('pc-02', '500.00')] }));

describe('sub-ledger ties (ruling 1)', () => {
  it('AR line not equal to Σ AR items is refused at issue with both figures; nothing is written', () => {
    const d = draft([L('1130', '1400.00', '0.00')], OP({ openItems: [AR('pc-01', '1000.00'), AR('pc-02', '500.00')] }));
    const series = JSON.stringify(st.series), docs = st.docs.length;
    const e = err(() => issue(st, d.id, d.version, ME));
    expect(e.code).toBe('ob.subledger_mismatch');
    expect(e.title).toContain('1400.00');
    expect(e.title).toContain('1500.00');
    expect(doc(d.id).status).toBe('draft');
    expect(ents(d.id)).toHaveLength(0);
    expect(JSON.stringify(st.series)).toBe(series);
    expect(st.docs.length).toBe(docs);
  });
  it('compute shows the same mismatch and the ties', () => {
    const r = compute(st, CO, 'OB', { header: { documentDate: '2026-06-30' }, lines: [L('2110', '0.00', '900.00')], opening: OP({ openItems: [AP('pv-01', '1000.00')] }) });
    expect(r.missing.map((m) => m.code)).toContain('ob.subledger_mismatch');
    expect(r.opening!.ties).toContainEqual(expect.objectContaining({ code: '2110', tb: '900.00', sub: '1000.00', ok: false }));
  });
  it('AP 2110, employee payable 2180, deposits 2140 and prepayments 1140 each tie to their items', () => {
    const items = (side: 'AP' | 'EMP' | 'DEP' | 'PRE', partyId: string) => ({ side, partyId, docNumber: 'X-1', docDate: '2026-05-01', amount: '100.00' });
    for (const [code, side, partyId, dr] of [['2110', 'AP', 'pv-01', false], ['2180', 'EMP', 'emp-01', false], ['2140', 'DEP', 'pc-01', false], ['1140', 'PRE', 'pv-01', true]] as const) {
      const bad = draft([L(code, dr ? '90.00' : '0.00', dr ? '0.00' : '90.00')], OP({ openItems: [items(side, partyId)] }));
      expect(err(() => issue(st, bad.id, bad.version, ME)).code, code).toBe('ob.subledger_mismatch');
      cancelDraft(bad.id);
    }
    const ok = post([L('2110', '0.00', '100.00'), L('2180', '0.00', '100.00'), L('2140', '0.00', '100.00'), L('1140', '100.00', '0.00')],
      OP({ openItems: [items('AP', 'pv-01'), items('EMP', 'emp-01'), items('DEP', 'pc-01'), items('PRE', 'pv-01')] }));
    expect(ok.status).toBe('issued');
    expect(checkInvariants(st)).toEqual([]);
  });
  it('trial-balance lines named per party tie per party (the totals are equal, one party is not)', () => {
    const d = draft([L('1130', '1100.00', '0.00', { partyId: 'pc-01' }), L('1130', '400.00', '0.00', { partyId: 'pc-02' })], OP({ openItems: [AR('pc-01', '1000.00'), AR('pc-02', '500.00')] }));
    const e = err(() => issue(st, d.id, d.version, ME));
    expect(e.code).toBe('ob.subledger_mismatch');
    expect(e.title).toContain('นาวาพาณิชย์'); // the first party that differs
    expect(e.title).toContain('1100.00');
    expect(e.title).toContain('1000.00');
    expect(compute(st, CO, 'OB', { header: { documentDate: '2026-06-30' }, lines: doc(d.id).lines, opening: doc(d.id).opening }).opening!.ties.filter((t) => !t.ok).map((t) => t.key)).toEqual(['AR:pc-01', 'AR:pc-02']);
  });
  it('fixed assets and accumulated depreciation tie to the asset step, by the account the class posts to', () => {
    const asset = { name: 'เครื่องพิมพ์', assetClass: 'equipment', cost: '50000.00', accumulated: '20000.00', acquired: '2024-01-01', lifeMonths: 60 };
    const bad = draft([L('1210', '50000.00', '0.00'), L('1211', '0.00', '25000.00')], OP({ assets: [asset] }));
    expect(err(() => issue(st, bad.id, bad.version, ME)).code).toBe('ob.subledger_mismatch');
    const ok = post([L('1210', '50000.00', '0.00'), L('1211', '0.00', '20000.00')], OP({ assets: [asset] }));
    expect(ents(ok.id)[0].lines.map((l) => [l.accountCode, l.debit, l.credit])).toContainEqual(['1211', '0.00', '20000.00']);
    expect(checkInvariants(st)).toEqual([]);
  });
  it('a bank / cash line without its bank step is a mismatch', () => {
    const d = draft([L('1122', '5000.00', '0.00')], OP());
    expect(err(() => issue(st, d.id, d.version, ME)).code).toBe('ob.subledger_mismatch');
  });
  it('VAT / WHT balances are plain lines: they post as typed and every invariant still holds [SP-R]', () => {
    const d = post([L('2151', '0.00', '700.00'), L('2131', '0.00', '120.00'), L('1170', '400.00', '0.00'), L('1180', '50.00', '0.00')], OP());
    expect(ents(d.id)[0].lines.map((l) => l.accountCode).sort()).toEqual(['1170', '1180', '2131', '2151', '3900']);
    expect(checkInvariants(st)).toEqual([]);
  });
});

describe('journal and the 3900 plug (ruling 5)', () => {
  it('posts one line per party, plain lines as typed, and the imbalance to 3900 so Dr = Cr', () => {
    const d = basic();
    const e = ents(d.id);
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({ kind: 'original', date: '2026-06-30' });
    expect(e[0].postedAt).toBeTruthy();
    expect(e[0].lines.filter((l) => l.accountCode === '1130').map((l) => [l.partyName, l.debit])).toEqual(expect.arrayContaining([[expect.any(String), '1000.00'], [expect.any(String), '500.00']]));
    const plug = e[0].lines.find((l) => l.accountCode === '3900')!;
    expect(plug).toMatchObject({ debit: '0.00', credit: '1400.00', rule: 'ผลต่างยกไปส่วนเกินทุนยอดยกมา' }); // Dr 1,700.00 against Cr 300.00
    const dr = e[0].lines.reduce((a, l) => a + sat(l.debit), 0), cr = e[0].lines.reduce((a, l) => a + sat(l.credit), 0);
    expect(dr).toBe(cr);
    expect(d.totals.total).toBe('1700.00');
    expect(checkInvariants(st)).toEqual([]);
  });
  it('compute states the plug before issue', () => {
    const r = compute(st, CO, 'OB', { header: { documentDate: '2026-06-30' }, lines: [L('1150', '200.00', '0.00'), L('2120', '0.00', '300.00')], opening: OP() });
    expect(r.opening).toMatchObject({ plug: '100.00', plugSide: 'Dr' });
  });
  it('a typed 3900 line is refused: the system owns it', () => {
    const d = draft([L('1150', '200.00', '0.00'), L('3900', '0.00', '200.00')], OP());
    expect(err(() => issue(st, d.id, d.version, ME)).code).toBe('ob.plug_account');
  });
  it('an empty opening is incomplete', () => {
    const d = draft([], OP());
    expect(err(() => issue(st, d.id, d.version, ME)).code).toBe('doc.incomplete');
  });
});

describe('frozen open items settle through the normal allocation (ruling 3)', () => {
  it('an RC settles an AR item: it shrinks, GL(1130) = Σ outstanding of TI ∪ IV ∪ OB, invariants hold; cancelling the RC gives it back', () => {
    const ob = basic(), item = `${ob.id}-i1`;
    expect(doc(item)).toMatchObject({ type: 'OB', status: 'issued', outstanding: '1000.00', number: 'IV-pc-01 (ยกมา)' });
    const before = gl('1130');
    const r = rc('pc-01', [{ targetId: item, targetType: 'OB', amount: '600.00' }]);
    expect(doc(item)).toMatchObject({ outstanding: '400.00', status: 'partly_settled' });
    expect(gl('1130') - before).toBe(-60000);
    expect(r.allocations![0].targetNumber).toBe('IV-pc-01 (ยกมา)');
    expect(checkInvariants(st)).toEqual([]);
    cancel(st, r.id, r.version, 'OTHER', 'test', ME);
    expect(doc(item)).toMatchObject({ outstanding: '1000.00', status: 'issued' });
    expect(checkInvariants(st)).toEqual([]);
  });
  it('the item belongs to its party and cannot be over-allocated', () => {
    const ob = post([L('1130', '1000.00', '0.00')], OP({ openItems: [AR('pc-01', '1000.00')] })), ar = `${ob.id}-i1`;
    const bad = (partyId: string, id: string, amount: string, type: 'RC' | 'PV') => {
      const d = createDraft(st, CO, type, { header: { partyId, documentDate: '2026-10-14' }, lines: [], allocations: [{ targetId: id, targetType: 'OB', amount }] }, ME, `x${++n}`);
      return err(() => issue(st, d.id, d.version, ME)).code;
    };
    expect(bad('pc-02', ar, '10.00', 'RC')).toBe('settle.party_mismatch');
    expect(bad('pc-01', ar, '1000.01', 'RC')).toBe('settle.over_allocation');
    expect(checkInvariants(st)).toEqual([]);
  });
  it('an RC settles only receivables and a PV only payables / employee items - never a deposit or prepayment of the SAME party, an in-transit item or the batch (the ledger would post cash with nothing cleared)', () => {
    const items = [AR('pc-01', '1000.00'), AP('pv-01', '800.00'), { side: 'DEP' as const, partyId: 'pc-01', docNumber: 'DEP-1', docDate: '2026-05-01', amount: '300.00' }, { side: 'PRE' as const, partyId: 'pv-01', docNumber: 'PRE-1', docDate: '2026-05-01', amount: '200.00' },
      { side: 'EMP' as const, partyId: 'emp-01', docNumber: 'EX-OLD', docDate: '2026-05-01', amount: '100.00' }];
    const ob = post([L('1130', '1000.00', '0.00'), L('2110', '0.00', '800.00'), L('2140', '0.00', '300.00'), L('1140', '200.00', '0.00'), L('2180', '0.00', '100.00'), L('1122', '150.00', '0.00')],
      OP({ openItems: items, bank: [{ accountId: 'ba-scb', statement: '100.00', inTransit: [{ kind: 'deposit', date: '2026-06-29', description: 'เช็คฝาก', amount: '50.00' }] }] }));
    const [ar, ap, dep, pre, emp] = [1, 2, 3, 4, 5].map((i) => `${ob.id}-i${i}`), transit = `${ob.id}-tba-scb-1`;
    const refuse = (type: 'RC' | 'PV', partyId: string, target: string) => {
      const before = { docs: st.docs.length, links: st.links.length };
      const d = createDraft(st, CO, type, { header: { partyId, documentDate: '2026-10-14' }, lines: [], allocations: [{ targetId: target, targetType: 'OB', amount: '10.00' }] }, ME, `w${++n}`);
      expect(err(() => issue(st, d.id, d.version, ME)).code, `${type} -> ${target}`).toBe('settle.wrong_type');
      expect(st.links.length).toBe(before.links);
      expect(doc(d.id).status).toBe('draft');
    };
    refuse('RC', 'pc-01', dep); refuse('RC', 'pv-01', ap); refuse('RC', 'pc-01', transit); refuse('RC', 'pc-01', ob.id);
    refuse('PV', 'pv-01', pre); refuse('PV', 'pc-01', ar); refuse('PV', 'pv-01', transit);
    rc('pc-01', [{ targetId: ar, targetType: 'OB', amount: '10.00' }]); // the right sides still settle
    pv('pv-01', [{ targetId: ap, targetType: 'OB', amount: '10.00' }]);
    pv('emp-01', [{ targetId: emp, targetType: 'OB', amount: '10.00' }]);
    expect(checkInvariants(st)).toEqual([]);
  });
  it('a PV settles an AP item and an employee item; AP 2110 / 2180 stay tied', () => {
    const ob = post([L('2110', '0.00', '800.00'), L('2180', '0.00', '300.00')], OP({ openItems: [AP('pv-01', '800.00'), { side: 'EMP', partyId: 'emp-01', docNumber: 'EX-OLD', docDate: '2026-05-01', amount: '300.00' }] }));
    pv('pv-01', [{ targetId: `${ob.id}-i1`, targetType: 'OB', amount: '800.00' }]);
    expect(doc(`${ob.id}-i1`)).toMatchObject({ outstanding: '0.00', status: 'settled' });
    pv('emp-01', [{ targetId: `${ob.id}-i2`, targetType: 'OB', amount: '100.00' }]);
    expect(doc(`${ob.id}-i2`).outstanding).toBe('200.00');
    expect(checkInvariants(st)).toEqual([]);
  });
  it('an item settled blocks cancel and a money revise, with the exit; a notes-only revise passes and keeps the settlement', () => {
    const ob = basic(), item = `${ob.id}-i1`;
    const r = rc('pc-01', [{ targetId: item, targetType: 'OB', amount: '600.00' }]);
    const e = err(() => cancel(st, ob.id, ob.version, 'OTHER', 'x', ME));
    expect(e.code).toBe('ob.locked');
    expect(e.title).toContain(r.number!);
    expect(derivedLocks(st, doc(ob.id) as never)).toContainEqual(expect.objectContaining({ kind: 'settlement', href: `/sales/receipts/${r.id}` })); // the exit leads to the receipt
    const o = doc(ob.id);
    expect(err(() => revise(st, ob.id, { header: o.header, lines: [L('1130', '1400.00', '0.00'), L('1150', '200.00', '0.00'), L('2120', '0.00', '300.00')], opening: OP({ openItems: [AR('pc-01', '900.00'), AR('pc-02', '500.00')] }) }, o.version, 'x', ME)).code).toBe('ob.locked');
    revise(st, ob.id, { header: { ...o.header, notes: 'หมายเหตุ' }, lines: o.lines, opening: o.opening }, o.version, 'notes', ME);
    expect(doc(item).outstanding).toBe('400.00');
    expect(checkInvariants(st)).toEqual([]);
    cancel(st, r.id, r.version, 'OTHER', 'x', ME); // the exit
    cancel(st, ob.id, doc(ob.id).version, 'OTHER', 'x', ME);
    expect(checkInvariants(st)).toEqual([]);
  });
});

describe('cancel and revise (reverse and repost at the cut-off)', () => {
  it('cancel reverses the entry at the cut-off, cancels the items and frees the slot', () => {
    const ob = basic();
    cancel(st, ob.id, ob.version, 'OTHER', 'ผิด', ME);
    const e = ents(ob.id);
    expect(e.map((x) => [x.kind, x.date])).toEqual([['original', '2026-06-30'], ['reversal', '2026-06-30']]);
    expect(doc(`${ob.id}-i1`).status).toBe('cancelled');
    expect(checkInvariants(st)).toEqual([]);
    expect(post([L('1150', '10.00', '0.00')], OP()).status).toBe('issued'); // a second one is allowed once the first is cancelled
  });
  it('a revise after an item was settled and released keeps the item ids (their old links stay valid) and cancels the items it drops', () => {
    const ob = basic(), o = doc(ob.id), r = rc('pc-01', [{ targetId: `${ob.id}-i1`, targetType: 'OB', amount: '600.00' }]);
    cancel(st, r.id, r.version, 'OTHER', 'x', ME);
    revise(st, ob.id, { header: o.header, lines: [L('1130', '1100.00', '0.00'), L('1150', '200.00', '0.00'), L('2120', '0.00', '300.00')], opening: OP({ openItems: [{ ...o.opening!.openItems[0], amount: '1100.00' }] }) }, o.version, 'x', ME); // the wizard echoes the ids it was given
    expect(doc(`${ob.id}-i1`)).toMatchObject({ status: 'issued', outstanding: '1100.00' });
    expect(doc(`${ob.id}-i2`).status).toBe('cancelled');
    expect(checkInvariants(st)).toEqual([]); // no link points at a vanished document
  });
  it('revise reverses and reposts at the cut-off and re-creates the items', () => {
    const ob = basic(), o = doc(ob.id);
    revise(st, ob.id, { header: o.header, lines: [L('1130', '1600.00', '0.00'), L('1150', '200.00', '0.00'), L('2120', '0.00', '300.00')], opening: OP({ openItems: [{ ...o.opening!.openItems[0], amount: '1100.00' }, o.opening!.openItems[1]] }) }, o.version, 'แก้ยอด', ME);
    expect(ents(ob.id).map((x) => [x.kind, x.date])).toEqual([['original', '2026-06-30'], ['reversal', '2026-06-30'], ['correction', '2026-06-30']]);
    expect(doc(`${ob.id}-i1`).outstanding).toBe('1100.00');
    expect(doc(ob.id).totals.total).toBe('1800.00');
    expect(checkInvariants(st)).toEqual([]);
  });
  it('a revise that breaks a tie is refused and changes nothing', () => {
    const ob = basic(), o = doc(ob.id);
    expect(err(() => revise(st, ob.id, { header: o.header, lines: [L('1130', '1.00', '0.00')], opening: o.opening }, o.version, 'x', ME)).code).toBe('ob.subledger_mismatch');
    expect(ents(ob.id)).toHaveLength(1);
  });
});

describe('period exemption and cut-off (ruling 4)', () => {
  it('an OB posts into a closed month at its cut-off; a JV dated there is still refused', () => {
    const ob = post([L('1150', '10.00', '0.00')], OP(), '2026-06-30');
    expect(ents(ob.id)[0].date).toBe('2026-06-30');
    expect(st.periods.find((p) => p.companyId === CO && p.month === '2026-06')!.status).toBe('closed');
    const jv = createDraft(st, CO, 'JV', { header: { documentDate: '2026-06-30' }, lines: [L('5110', '5.00', '0.00'), L('2120', '0.00', '5.00')] }, ME, `jv${++n}`);
    expect(err(() => issue(st, jv.id, jv.version, ME)).code).toBe('period.closed');
    cancel(st, ob.id, ob.version, 'OTHER', 'x', ME); // cancel is exempt too
    expect(checkInvariants(st)).toEqual([]);
  });
  it('the cut-off must be before the earliest OPEN month of the period calendar (open months already hold documents), not just before today\'s month', () => {
    for (const date of ['2026-10-01', '2026-09-30', '2026-07-01']) { // 2026-07 .. 2026-12 are open in the seed
      const d = draft([L('1150', '10.00', '0.00')], OP(), date);
      expect(err(() => issue(st, d.id, d.version, ME)).code, date).toBe('ob.cutoff');
    }
    expect(post([L('1150', '10.00', '0.00')], OP(), '2026-06-30').status).toBe('issued');
  });
  it('closing the next month moves the limit with it', () => {
    const p = st.periods.find((x) => x.companyId === CO && x.month === '2026-07')!;
    p.status = 'closed'; (p as { closedAt?: string }).closedAt = '2026-08-10T09:00:00+07:00';
    expect(post([L('1150', '10.00', '0.00')], OP(), '2026-07-31').status).toBe('issued');
  });
  it('at most one live OB per company', () => {
    post([L('1150', '10.00', '0.00')], OP());
    const d = draft([L('1150', '10.00', '0.00')], OP());
    expect(err(() => issue(st, d.id, d.version, ME)).code).toBe('ob.already_exists');
  });
});

describe('FN3 settlement records do not take opening items', () => {
  it('a write-off / netting of an OB item is refused by type (the FN3 form never asks for OB items either)', () => {
    const ob = basic();
    const e = err(() => postSettlement(st, CO, { kind: 'write_off', date: '2026-10-14', partyId: 'pc-01', targets: [{ docId: `${ob.id}-i1`, amount: '1.00' }], difference: { role: 'SmallWriteOff', amount: '1.00' } }, ME));
    expect(e.code).toBe('settle.wrong_type');
    expect(checkInvariants(st)).toEqual([]);
  });
});

describe('bank go-live opening (ruling 2)', () => {
  const bankOp = () => OP({ bank: [{ accountId: 'ba-scb', statement: '10000.00', inTransit: [
    { kind: 'deposit', date: '2026-06-29', description: 'เช็คลูกค้านำฝากวันสุดท้าย', amount: '2500.00' }, { kind: 'payment', date: '2026-06-28', description: 'เช็คจ่ายค่าเช่า', amount: '400.00' }] }] });
  it('GL line = statement + deposits - payments; go-live = cut-off + 1; the in-transit items exist; invariants hold', () => {
    const ob = post([L('1122', '12100.00', '0.00')], bankOp());
    expect(ents(ob.id)[0].lines.find((l) => l.accountCode === '1122')).toMatchObject({ debit: '12100.00', credit: '0.00' });
    expect(st.bankAccounts.find((b) => b.id === 'ba-scb')).toMatchObject({ goLive: '2026-07-01', goLiveBy: ob.id });
    expect(st.docs.filter((d) => d.header.obBatchId === ob.id).map((d) => [d.header.obKind, d.totals.total])).toEqual([['DIT', '2500.00'], ['OP', '400.00']]);
    expect(checkInvariants(st)).toEqual([]);
  });
  it('a TB line that is not statement + in-transit is a mismatch', () => {
    const d = draft([L('1122', '12000.00', '0.00')], bankOp());
    const e = err(() => issue(st, d.id, d.version, ME));
    expect(e.code).toBe('ob.subledger_mismatch');
    expect(e.title).toContain('12000.00');
    expect(e.title).toContain('12100.00');
  });
  it('an account with a go-live cannot be opened again; cancelling frees it', () => {
    const ob = post([L('1122', '12100.00', '0.00')], bankOp());
    const d2 = draft([L('1122', '12100.00', '0.00')], bankOp());
    const e = err(() => compute(st, CO, 'OB', { header: doc(d2.id).header, lines: doc(d2.id).lines, opening: bankOp() }).missing.forEach((m) => { throw Object.assign(new Error(m.message), { code: m.code, title: m.message }); }));
    expect(e.code === 'ob.already_exists' || e.code === 'ob.bank_live').toBe(true);
    cancel(st, ob.id, ob.version, 'OTHER', 'x', ME);
    expect(st.bankAccounts.find((b) => b.id === 'ba-scb')!.goLive).toBeUndefined();
    expect(issue(st, d2.id, d2.version, ME).status).toBe('issued');
  });
  it('an account that already has a statement (a go-live of its own) is refused with the cause', () => {
    const d = draft([L('1121', '1.00', '0.00')], OP({ bank: [{ accountId: 'ba-kbank', statement: '1.00', inTransit: [] }] }));
    const e = err(() => issue(st, d.id, d.version, ME));
    expect(e.code).toBe('ob.bank_live');
    expect(e.title).toContain('2026-09-01');
  });
  it('an in-transit item matches a statement line like an RC / PV; the batch is then locked until unmatched', () => {
    const ob = post([L('1122', '12100.00', '0.00')], bankOp());
    st.bankLines.push({ companyId: CO, id: 'bl-ob-1', accountId: 'ba-scb', importId: 'imp-x', date: '2026-07-02', description: 'เช็คเข้า', amount: '2500.00', balance: '12500.00', status: 'unmatched' } as never);
    const c = suggest(st, CO, 'bl-ob-1');
    expect(c.map((x) => x.docId)).toContain(`${ob.id}-t${'ba-scb'}-1`);
    const itemId = c.find((x) => x.docId.startsWith(ob.id))!.docId;
    match(st, CO, 'bl-ob-1', { docIds: [itemId] }, ME);
    expect(st.bankLines.find((l) => l.id === 'bl-ob-1')!.status).toBe('matched');
    expect(err(() => cancel(st, ob.id, ob.version, 'OTHER', 'x', ME)).code).toBe('ob.locked');
    expect(derivedLocks(st, doc(ob.id) as never)).toContainEqual(expect.objectContaining({ kind: 'reconciliation' }));
    expect(checkInvariants(st)).toEqual([]);
    unmatch(st, CO, 'bl-ob-1', ME);
    cancel(st, ob.id, ob.version, 'OTHER', 'x', ME);
    expect(checkInvariants(st)).toEqual([]);
  });
  it('the reconciliation report lists the unmatched in-transit items', () => {
    post([L('1122', '12100.00', '0.00')], bankOp());
    const r = bankReconciliation(st, CO, { account: 'ba-scb', to: '2026-07-31' });
    expect(r.rows.some((x) => x.cells.item?.includes('เช็คลูกค้านำฝากวันสุดท้าย'))).toBe(true);
    expect(r.rows.some((x) => x.cells.item?.includes('เช็คจ่ายค่าเช่า'))).toBe(true);
  });
});

function cancelDraft(id: string) { st.docs = st.docs.filter((d) => d.id !== id); }

describe('revise through the correction plan (what the wizard sends)', () => {
  it('a change of the steps only (same trial-balance lines) is a plan with one revise step; executing it reposts at the cut-off and re-creates the items', () => {
    const ob = basic(), o = doc(ob.id);
    const opening = OP({ openItems: [AR('pc-01', '1000.00'), AR('pc-02', '300.00'), AR('pc-02', '200.00', 'IV-second')] }); // same Σ, one more item
    const plan = correctionPlan(st, ob.id, { header: o.header, lines: o.lines, opening }, 'accountant');
    expect(plan.steps.map((s) => s.action)).toEqual(['revise']);
    executePlan(st, plan.planId, plan.planHash, ME, 'accountant');
    expect(doc(ob.id).opening!.openItems).toHaveLength(3);
    expect(st.docs.filter((d) => d.header.obBatchId === ob.id && d.status === 'issued')).toHaveLength(3);
    expect(ents(ob.id).map((x) => x.kind)).toEqual(['original', 'reversal', 'correction']);
    expect(checkInvariants(st)).toEqual([]);
  });
  it('a plan that would move a settled item is refused before it is shown', () => {
    const ob = basic(), o = doc(ob.id);
    rc('pc-01', [{ targetId: `${ob.id}-i1`, targetType: 'OB', amount: '100.00' }]);
    expect(err(() => correctionPlan(st, ob.id, { header: o.header, lines: o.lines, opening: OP({ openItems: [AR('pc-01', '1000.00'), AR('pc-02', '300.00'), AR('pc-02', '200.00', 'IV-second')] }) }, 'accountant')).code).toBe('ob.locked');
  });
});

// ---- AC3 fix round 1: F1 freeze at issue, F2 bank statement lock, F3 stable item ids
const rename = (id: string) => { const p = st.parties.find((x) => x.id === id)!; p.name += ' (ใหม่)'; return p.name; };
const lastLines = (id: string) => JSON.stringify([...ents(id)].reverse().find((e) => e.kind !== 'reversal')!.lines);
const itemOf = (ob: { id: string }, partyId: string) => st.docs.find((d) => d.header.obBatchId === ob.id && d.header.partyId === partyId && d.status !== 'cancelled')!;
const lines3 = (x = '200.00') => [L('1130', '1500.00', '0.00'), L('1150', x, '0.00'), L('2120', '0.00', '300.00')];

describe('F1: what the OB journal derives from editable data is frozen at issue', () => {
  it('renaming a party after issue changes neither the journal nor the invariants; an RC clears the item under the frozen name', () => {
    const ob = basic(), before = lastLines(ob.id), oldName = itemOf(ob, 'pc-01').party!.name;
    rename('pc-01');
    expect(checkInvariants(st)).toEqual([]);
    expect(lastLines(ob.id)).toBe(before);
    rc('pc-01', [{ targetId: itemOf(ob, 'pc-01').id, targetType: 'OB', amount: '1000.00' }]);
    expect(itemOf(ob, 'pc-01').party!.name).toBe(oldName);
    expect(checkInvariants(st)).toEqual([]);
  });
  it('a plain-line revise (steps unchanged) after a rename keeps the frozen name; so does a notes-only revise of a settled batch', () => {
    const ob = basic();
    rename('pc-01');
    const o = doc(ob.id);
    revise(st, ob.id, { header: o.header, lines: lines3('250.00'), opening: o.opening }, o.version, 'x', ME);
    expect(lastLines(ob.id)).toContain('บริษัท นาวาพาณิชย์ จำกัด');
    expect(lastLines(ob.id)).not.toContain('(ใหม่)');
    expect(checkInvariants(st)).toEqual([]);
    rc('pc-01', [{ targetId: itemOf(ob, 'pc-01').id, targetType: 'OB', amount: '1000.00' }]);
    const o2 = doc(ob.id), before2 = lastLines(ob.id);
    revise(st, ob.id, { header: { ...o2.header, notes: 'หมายเหตุใหม่' }, lines: o2.lines, opening: OP({ openItems: [AR('pc-01', '1000.00'), AR('pc-02', '500.00')] }) }, o2.version, 'x', ME); // the client sends no server fields
    expect(lastLines(ob.id)).toBe(before2);
    expect(checkInvariants(st)).toEqual([]);
  });
  it('a money revise after a rename re-freezes the journal and the item together under the new name', () => {
    const ob = basic(), o = doc(ob.id), name = rename('pc-01');
    revise(st, ob.id, { header: o.header, lines: [L('1130', '1600.00', '0.00'), L('1150', '200.00', '0.00'), L('2120', '0.00', '300.00')], opening: { ...o.opening!, openItems: [{ ...o.opening!.openItems[0], amount: '1100.00' }, o.opening!.openItems[1]] } }, o.version, 'x', ME);
    expect(itemOf(ob, 'pc-01').party!.name).toBe(name);
    expect(lastLines(ob.id)).toContain(name);
    expect(checkInvariants(st)).toEqual([]);
  });
  it('a caller cannot send the frozen name or codes: they are replaced from the master data at the write', () => {
    const o = OP({ openItems: [{ ...AR('pc-01', '1000.00'), partyName: 'ปลอม' }, AR('pc-02', '500.00')], codes: { AR: '9999' } });
    const ob = post(lines3(), o);
    expect(doc(ob.id).opening!.openItems[0].partyName).not.toBe('ปลอม');
    expect(doc(ob.id).opening!.codes!.AR).toBe('1130');
    expect(checkInvariants(st)).toEqual([]);
  });
  it('a posting-rule remap after issue changes neither the stored journal nor the OB invariant', () => {
    basic();
    const a = st.accounts.find((x) => x.companyId === CO && x.code === '1130')!;
    st.accounts.push({ ...a, code: '1139', nameTh: 'ลูกหนี้อื่น' });
    st.postingRules.find((r) => r.companyId === CO && r.role === 'AR' && r.level === 'default')!.accountCode = '1139';
    expect(obInvariants(st)).toEqual([]);
  });
});

describe('F2: an imported statement on an account the batch opened locks the parts it fixed', () => {
  const imp = () => st.bankImports.push({ id: 'imp-p', companyId: CO, accountId: 'ba-scb', from: '2026-07-01', to: '2026-07-31' } as never);
  const bank = (statement = '10000.00') => OP({ bank: [{ accountId: 'ba-scb', statement, inTransit: [] }] });
  it('cancel is refused (ob.locked); the go-live and the GL opening stay', () => {
    const ob = post([L('1122', '10000.00', '0.00')], bank());
    imp();
    const e = err(() => cancel(st, ob.id, doc(ob.id).version, 'OTHER', 'x', ME));
    expect(e.code).toBe('ob.locked');
    expect(e.title).toContain('แก้ไขยอดยกมา');
    expect(gl('1122')).toBe(1_000_000);
  });
  it('a change of that account statement, of the cut-off, or dropping its step is refused', () => {
    const ob = post([L('1122', '10000.00', '0.00')], bank()), o = doc(ob.id);
    imp();
    expect(err(() => revise(st, ob.id, { header: o.header, lines: [L('1122', '9000.00', '0.00')], opening: bank('9000.00') }, o.version, 'x', ME)).code).toBe('ob.locked');
    expect(err(() => revise(st, ob.id, { header: { ...o.header, documentDate: '2026-06-29' }, lines: o.lines, opening: o.opening }, o.version, 'x', ME)).code).toBe('ob.locked');
    expect(err(() => revise(st, ob.id, { header: o.header, lines: [L('1130', '5.00', '0.00')], opening: OP({ openItems: [AR('pc-01', '5.00')] }) }, o.version, 'x', ME)).code).toBe('ob.locked');
  });
  it('a revise of a line or step elsewhere is still allowed', () => {
    const ob = post([L('1122', '10000.00', '0.00'), L('1150', '200.00', '0.00')], bank()), o = doc(ob.id);
    imp();
    revise(st, ob.id, { header: o.header, lines: [L('1122', '10000.00', '0.00'), L('1150', '250.00', '0.00')], opening: o.opening }, o.version, 'x', ME);
    expect(doc(ob.id).totals.total).toBe('10250.00');
    expect(checkInvariants(st)).toEqual([]);
  });
});

describe('F3: open items keep a server-owned id across revises', () => {
  const three = () => post([L('1130', '1700.00', '0.00')], OP({ openItems: [AR('pc-01', '1000.00', 'IV-A'), AR('pc-01', '500.00', 'IV-B'), AR('pc-01', '200.00', 'IV-C')] }));
  const dropFirst = (ob: { id: string }) => {
    const o = doc(ob.id), [, b, c] = o.opening!.openItems;
    revise(st, ob.id, { header: o.header, lines: [L('1130', '700.00', '0.00')], opening: OP({ openItems: [b, c] }) }, o.version, 'x', ME);
  };
  it('after dropping IV-A a draft RC on IV-B still settles IV-B, never IV-C', () => {
    const ob = three(), idB = doc(ob.id).opening!.openItems[1].id!;
    const r = createDraft(st, CO, 'RC', { header: { partyId: 'pc-01', documentDate: '2026-10-14' }, lines: [], allocations: [{ targetId: idB, targetType: 'OB', amount: '500.00' }] }, ME, `rc${++n}`);
    dropFirst(ob);
    issue(st, r.id, r.version, ME);
    expect(doc(idB)).toMatchObject({ number: 'IV-B (ยกมา)', status: 'settled' });
    expect(st.docs.find((d) => d.number === 'IV-C (ยกมา)')!.outstanding).toBe('200.00');
    expect(st.docs.find((d) => d.number === 'IV-A (ยกมา)')!.status).toBe('cancelled');
    expect(checkInvariants(st)).toEqual([]);
  });
  it('a draft RC on the DROPPED item is refused, not moved to another', () => {
    const ob = three(), idA = doc(ob.id).opening!.openItems[0].id!;
    const r = createDraft(st, CO, 'RC', { header: { partyId: 'pc-01', documentDate: '2026-10-14' }, lines: [], allocations: [{ targetId: idA, targetType: 'OB', amount: '500.00' }] }, ME, `rc${++n}`);
    dropFirst(ob);
    expect(() => issue(st, r.id, r.version, ME)).toThrow();
  });
  it('a caller cannot invent an id or reuse a dropped one: a row with an unknown id gets a fresh one', () => {
    const ob = three(), idA = doc(ob.id).opening!.openItems[0].id!;
    dropFirst(ob);
    const o = doc(ob.id);
    revise(st, ob.id, { header: o.header, lines: [L('1130', '900.01', '0.00')], opening: OP({ openItems: [...o.opening!.openItems, { ...AR('pc-01', '200.00', 'IV-D'), id: idA }, { ...AR('pc-01', '0.01', 'IV-E'), id: 'someone-elses-i1' }] }) }, o.version, 'x', ME);
    const ids = doc(ob.id).opening!.openItems.map((i) => i.id);
    expect(new Set(ids).size).toBe(4);
    expect(ids).not.toContain(idA);
    expect(ids).not.toContain('someone-elses-i1');
    expect(doc(idA).status).toBe('cancelled');
  });
});
