import { beforeEach, describe, expect, it } from 'vitest';
import type { Actor, DocHeader } from '@/domain/types';
import { buildSeedState, type MockState } from '../store';
import { cancel, createDraft, issue, revise } from './commands';
import { buildPlan } from './corrections';
import { checkInvariants } from './invariants';
import { derivedLocks, settlementLock } from './locks';
import type { MockError } from './log';
import { fromSatang, toSatang } from './money';
import { depositsOf, postSettlement, reverseSettlement, unappliedOf, type SettleRequest } from './settlement-records';
import { assertBalanced } from './test-helpers';

const ME: Actor = { kind: 'user', id: 'u-1', name: 'สมศรี บัญชีดี' };
const CO = 'co-vat', DAY = '2026-10-14';
let st: MockState;
beforeEach(() => { localStorage.clear(); st = buildSeedState(); });

const err = (fn: () => unknown): MockError => { try { fn(); } catch (e) { return e as MockError; } throw new Error('expected a refusal'); };
const doc = (id: string) => st.docs.find((d) => d.id === id)!;
/** Debit - credit of one account over every journal the company has (documents', reconciliation's, settlements'). */
const gl = (code: string, co = CO): number => {
  let n = 0;
  for (const j of st.journals) if (doc(j.docId).companyId === co) for (const e of j.preview.entries) for (const l of e.lines) if (l.accountCode === code) n += toSatang(l.debit) - toSatang(l.credit);
  for (const j of st.bankJournals) if (j.companyId === co) for (const e of j.entries) for (const l of e.lines) if (l.accountCode === code) n += toSatang(l.debit) - toSatang(l.credit);
  for (const s of st.settlements) if (s.companyId === co) for (const e of s.journal) for (const l of e.lines) if (l.accountCode === code) n += toSatang(l.debit) - toSatang(l.credit);
  return n;
};
const deposit = (extra: Partial<SettleRequest> = {}): SettleRequest => ({ kind: 'apply_deposit', date: DAY, partyId: 'pc-08', sources: [{ docId: 'rc-dep', amount: '3210.00' }], targets: [{ docId: 'ti-dep', amount: '3210.00' }], ...extra });
/** A fresh vendor prepayment (issued through the engine) for a vendor of the seed. */
const prepay = (partyId: string, amount: string): string => {
  const d = createDraft(st, CO, 'PV', { header: { partyId, documentDate: DAY, depositAmount: amount }, lines: [] }, ME, `k-${partyId}-${amount}`);
  return issue(st, d.id, d.version, ME).id;
};

describe('apply a customer deposit to an invoice', () => {
  it('drops the target outstanding and GL 2140, keeps the rest of the deposit, and every invariant holds', () => {
    const before2140 = gl('2140'), before1130 = gl('1130');
    expect(unappliedOf(st, doc('rc-dep'))).toBe(500000);
    const s = postSettlement(st, CO, deposit(), ME);
    expect(s).toMatchObject({ id: 'stl-002', kind: 'apply_deposit', status: 'posted', partyId: 'pc-08', date: DAY });
    expect(doc('ti-dep')).toMatchObject({ outstanding: '0.00', status: 'settled' });
    expect(unappliedOf(st, doc('rc-dep'))).toBe(179000);
    expect(gl('2140') - before2140).toBe(321000);
    expect(gl('1130') - before1130).toBe(-321000);
    const e = s.journal[0];
    expect(e).toMatchObject({ date: DAY, kind: 'original' });
    expect(e.postedAt).toBeTruthy();
    expect(e.lines.map((l) => [l.accountCode, l.debit, l.credit, l.partyName])).toEqual([['2140', '3210.00', '0.00', 'บริษัท ไทยพัฒนาก่อสร้าง จำกัด'], ['1130', '0.00', '3210.00', 'บริษัท ไทยพัฒนาก่อสร้าง จำกัด']]);
    expect(st.links.filter((l) => l.from === s.id && l.active).map((l) => [l.to, l.kind, l.amount])).toEqual([['rc-dep', 'settles', '3210.00'], ['ti-dep', 'settles', '3210.00']]);
    assertBalanced(st);
    expect(depositsOf(st, CO).find((r) => r.docId === 'rc-dep')).toMatchObject({ amount: '5000.00', applied: '3210.00', remaining: '1790.00' });
  });
  it('a partial application leaves the invoice partly settled', () => {
    postSettlement(st, CO, deposit({ sources: [{ docId: 'rc-dep', amount: '1000.00' }], targets: [{ docId: 'ti-dep', amount: '1000.00' }] }), ME);
    expect(doc('ti-dep')).toMatchObject({ outstanding: '2210.00', status: 'partly_settled' });
    expect(checkInvariants(st)).toEqual([]);
  });
  it('refuses more than the deposit has left, more than the target owes, another party, another company and a duplicate', () => {
    expect(err(() => postSettlement(st, CO, deposit({ sources: [{ docId: 'rc-dep', amount: '5000.01' }], targets: [{ docId: 'ti-dep', amount: '3210.00' }], difference: undefined }), ME)).code).toBe('settle.over_application');
    expect(err(() => postSettlement(st, CO, deposit({ targets: [{ docId: 'ti-dep', amount: '3210.01' }], sources: [{ docId: 'rc-dep', amount: '3210.01' }] }), ME)).code).toBe('settle.over_allocation');
    expect(err(() => postSettlement(st, CO, deposit({ targets: [{ docId: 'ti-net', amount: '3210.00' }] }), ME)).code).toBe('settle.party_mismatch');
    expect(err(() => postSettlement(st, 'co-nonvat', deposit(), ME)).code).toBe('settle.party_not_found');
    expect(err(() => postSettlement(st, CO, deposit({ targets: [{ docId: 'ti-dep', amount: '1000.00' }, { docId: 'ti-dep', amount: '2210.00' }] }), ME)).code).toBe('settle.duplicate_target');
    expect(err(() => postSettlement(st, CO, deposit({ kind: 'apply_prepayment' }), ME)).code).toBe('settle.wrong_type');
    postSettlement(st, CO, deposit(), ME);
    expect(err(() => postSettlement(st, CO, deposit({ sources: [{ docId: 'rc-dep', amount: '1790.00' }], targets: [{ docId: 'ti-dep', amount: '1790.00' }] }), ME)).code).toBe('settle.over_allocation'); // the target is paid up
    expect(st.settlements).toHaveLength(2); // seed stl-001 + the one above: nothing was written by a refusal
    expect(checkInvariants(st)).toEqual([]);
  });
  it('refuses a source and target that do not balance, a future date and a closed period', () => {
    expect(err(() => postSettlement(st, CO, deposit({ sources: [{ docId: 'rc-dep', amount: '3000.00' }] }), ME)).code).toBe('settle.unbalanced');
    expect(err(() => postSettlement(st, CO, deposit({ date: '2026-10-15' }), ME)).code).toBe('doc.future_date');
    expect(err(() => postSettlement(st, CO, deposit({ date: '2026-06-15' }), ME)).code).toBe('period.closed');
    expect(err(() => postSettlement(st, CO, deposit({ date: '2026-10-01' }), ME)).code).toBe('settle.date_before_document');
  });
});

describe('differences within the company tolerance', () => {
  const near = (role: 'RoundingDifference' | 'SmallWriteOff' | 'BankFee', diff: string, applied = '3209.00'): SettleRequest =>
    deposit({ sources: [{ docId: 'rc-dep', amount: applied }], targets: [{ docId: 'ti-dep', amount: fromSatang(toSatang(applied) + toSatang(diff)) }], difference: { role, amount: diff } });
  it('rounding up to 1.00 posts to 5210, a small write-off up to 100.00 to 5220, and the invoice is cleared', () => {
    const s = postSettlement(st, CO, near('RoundingDifference', '1.00'), ME);
    expect(s.difference).toEqual({ role: 'RoundingDifference', amount: '1.00' });
    expect(s.journal[0].lines.map((l) => [l.accountCode, l.debit, l.credit])).toEqual([['2140', '3209.00', '0.00'], ['5210', '1.00', '0.00'], ['1130', '0.00', '3210.00']]);
    expect(doc('ti-dep')).toMatchObject({ outstanding: '0.00', status: 'settled' });
    assertBalanced(st);
    reverseSettlement(st, CO, s.id, ME);
    const w = postSettlement(st, CO, near('SmallWriteOff', '100.00', '3110.00'), ME);
    expect(w.journal[0].lines.some((l) => l.accountCode === '5220' && l.debit === '100.00')).toBe(true);
    expect(checkInvariants(st)).toEqual([]);
  });
  it('above the tolerance is refused: rounding over 1.00, a write-off or a bank fee over 100.00 (settle.beyond_tolerance)', () => {
    expect(err(() => postSettlement(st, CO, near('RoundingDifference', '1.01', '3208.99'), ME))).toMatchObject({ code: 'settle.beyond_tolerance', title: 'เกินเกณฑ์ที่กำหนด ต้องออกใบลดหนี้หรือรับชำระเพิ่ม' });
    expect(err(() => postSettlement(st, CO, near('SmallWriteOff', '100.01', '3109.99'), ME)).code).toBe('settle.beyond_tolerance');
    expect(err(() => postSettlement(st, CO, near('BankFee', '100.01', '3109.99'), ME)).code).toBe('settle.beyond_tolerance');
    expect(st.settlements).toHaveLength(1);
  });
  it('the tolerance is a company setting', () => {
    st.settlementTolerance.find((t) => t.companyId === CO)!.rounding = '5.00';
    expect(postSettlement(st, CO, near('RoundingDifference', '5.00', '3205.00'), ME).status).toBe('posted');
  });
  it('a write-off alone clears a small residual of an invoice (and nothing above the tolerance)', () => {
    postSettlement(st, CO, deposit({ sources: [{ docId: 'rc-dep', amount: '3209.50' }], targets: [{ docId: 'ti-dep', amount: '3209.50' }] }), ME);
    const w = postSettlement(st, CO, { kind: 'write_off', date: DAY, partyId: 'pc-08', targets: [{ docId: 'ti-dep', amount: '0.50' }], difference: { role: 'RoundingDifference', amount: '0.50' } }, ME);
    expect(w.sources).toEqual([]);
    expect(w.journal[0].lines.map((l) => [l.accountCode, l.debit, l.credit])).toEqual([['5210', '0.50', '0.00'], ['1130', '0.00', '0.50']]);
    expect(doc('ti-dep')).toMatchObject({ outstanding: '0.00', status: 'settled' });
    expect(checkInvariants(st)).toEqual([]);
    expect(err(() => postSettlement(st, CO, { kind: 'write_off', date: DAY, partyId: 'pc-05', targets: [{ docId: 'ti-net', amount: '100.00' }], difference: { role: 'SmallWriteOff', amount: '100.00' } }, ME)).code).toBe('settle.party_mismatch');
    expect(err(() => postSettlement(st, CO, { kind: 'write_off', date: DAY, partyId: 'pc-02', targets: [{ docId: 'ti-net', amount: '200.00' }], difference: { role: 'SmallWriteOff', amount: '200.00' } }, ME)).code).toBe('settle.beyond_tolerance');
  });
});

describe('reversal', () => {
  it('restores the outstanding, the deposit and the ledger with one reversing journal on the original date; twice is refused', () => {
    const base = [gl('2140'), gl('1130')];
    const s = postSettlement(st, CO, deposit(), ME);
    const r = reverseSettlement(st, CO, s.id, ME, 'ลูกค้าขอเปลี่ยนใบกำกับ');
    expect(r.status).toBe('reversed');
    expect(r.journal.map((e) => [e.kind, e.date])).toEqual([['original', DAY], ['reversal', DAY]]);
    expect(r.reversal).toMatchObject({ reason: 'ลูกค้าขอเปลี่ยนใบกำกับ' });
    expect(doc('ti-dep')).toMatchObject({ outstanding: '3210.00', status: 'issued' });
    expect(unappliedOf(st, doc('rc-dep'))).toBe(500000);
    expect([gl('2140'), gl('1130')]).toEqual(base);
    expect(st.links.filter((l) => l.from === s.id && l.active)).toEqual([]);
    expect(err(() => reverseSettlement(st, CO, s.id, ME)).code).toBe('settle.already_reversed');
    expect(err(() => reverseSettlement(st, 'co-nonvat', s.id, ME)).code).toBe('settlement.not_found');
    assertBalanced(st);
  });
  it('a closed period gets the reversal late, on the first open date (SP0 5.9)', () => {
    const stl1 = st.settlements[0]; // the seeded stl-001 sits in October, open: closing the month sends the reversal to the first open date
    st.periods.find((p) => p.companyId === CO && p.month === '2026-10')!.status = 'closed';
    st.periods.find((p) => p.companyId === CO && p.month === '2026-10')!.closedAt = '2026-10-15T00:00:00+07:00';
    const r = reverseSettlement(st, CO, stl1.id, ME);
    expect(r.journal[1]).toMatchObject({ kind: 'reversal', late: true });
    expect(r.journal[1].date).toBe('2026-11-01');
  });
});

describe('locks with exits', () => {
  it('an applied deposit cannot be cancelled, reissued, planned or revised in its cash / deposit / party / date; the exit is the settlement', () => {
    const s = postSettlement(st, CO, deposit(), ME);
    const rc = doc('rc-dep');
    expect(derivedLocks(st, rc)).toEqual([expect.objectContaining({ kind: 'settlement', exits: ['ย้อนรายการหักกลบ'], href: `/finance/settlements/${s.id}` })]);
    expect(err(() => cancel(st, 'rc-dep', rc.version, 'OTHER', 'x', ME)).code).toBe('doc.settled');
    const same = { header: rc.header, lines: rc.lines, allocations: rc.allocations };
    // a receipt (T) never takes a fiscal change in place; the plan that would route it is refused with the settlement's exit
    expect(err(() => revise(st, 'rc-dep', { ...same, header: { ...rc.header, depositAmount: '4000.00' } }, rc.version, 'r', ME)).code).toBe('doc.revise_not_allowed');
    expect(err(() => buildPlan(st, 'rc-dep', { ...same, header: { ...rc.header, depositAmount: '4000.00' } }, 'accountant')).code).toBe('doc.settled');
    expect(revise(st, 'rc-dep', { ...same, header: { ...rc.header, notes: 'บันทึกเพิ่ม' } }, rc.version, 'note', ME).header.notes).toBe('บันทึกเพิ่ม'); // a note alone is free
    // the target: cancel and a fiscal correction are refused with the same exit
    const ti = doc('ti-dep');
    expect(err(() => cancel(st, 'ti-dep', ti.version, 'OTHER', 'x', ME)).code).toBe('doc.settled');
    const edit = { header: ti.header, lines: ti.lines.map((l) => ({ ...l, unitPrice: '4000.00' })) };
    expect(err(() => buildPlan(st, 'ti-dep', edit, 'accountant')).code).toBe('doc.settled');
    expect(settlementLock(st, 'ti-dep')?.href).toBe(`/finance/settlements/${s.id}`);
    // the exit works: reverse it and the documents are free again
    reverseSettlement(st, CO, s.id, ME);
    expect(derivedLocks(st, doc('rc-dep'))).toEqual([]);
    expect(cancel(st, 'ti-dep', doc('ti-dep').version, 'OTHER', 'x', ME).status).toBe('cancelled');
  });
  it('a voucher whose prepayment was applied keeps its prepayment, party and date (L-class revise)', () => {
    const s = postSettlement(st, CO, { kind: 'apply_prepayment', date: DAY, partyId: 'pv-05', sources: [{ docId: 'pv-prep', amount: '500.00' }], targets: [{ docId: 'pb-prep', amount: '500.00' }] }, ME);
    const pv = doc('pv-prep');
    expect(err(() => cancel(st, 'pv-prep', pv.version, 'OTHER', 'x', ME)).code).toBe('doc.settled');
    expect(err(() => revise(st, 'pv-prep', { header: { ...pv.header, depositAmount: '2000.00' }, lines: [] }, pv.version, 'r', ME)).code).toBe('doc.settled');
    expect(err(() => revise(st, 'pv-prep', { header: { ...pv.header, documentDate: '2026-10-13' }, lines: [] }, pv.version, 'r', ME)).code).toBe('doc.settled');
    expect(revise(st, 'pv-prep', { header: { ...pv.header, notes: 'หมายเหตุ' }, lines: [] }, pv.version, 'note', ME).header.notes).toBe('หมายเหตุ');
    reverseSettlement(st, CO, s.id, ME);
    expect(revise(st, 'pv-prep', { header: { ...doc('pv-prep').header, depositAmount: '2000.00' }, lines: [] }, doc('pv-prep').version, 'r', ME).totals.total).toBe('2000.00');
    expect(checkInvariants(st)).toEqual([]);
  });
  it('an invoice (L-class) with a deposit applied cannot be revised to another total, up or down', () => {
    const rc = createDraft(st, 'co-nonvat', 'RC', { header: { partyId: 'nc-01', documentDate: DAY, depositAmount: '1000.00', bankAccountId: 'nba-kbank' }, lines: [] }, ME, 'k-nrc');
    const dep = issue(st, rc.id, rc.version, ME).id;
    const s = postSettlement(st, 'co-nonvat', { kind: 'apply_deposit', date: DAY, partyId: 'nc-01', sources: [{ docId: dep, amount: '1000.00' }], targets: [{ docId: 'iv-1', amount: '1000.00' }] }, ME);
    const iv = doc('iv-1');
    const body = (price: string) => ({ header: iv.header, lines: iv.lines.map((l) => ({ ...l, unitPrice: price })) });
    expect(err(() => revise(st, 'iv-1', body('130.00'), iv.version, 'r', ME)).code).toBe('doc.settled'); // 5,200.00 against 4,800.00
    expect(err(() => revise(st, 'iv-1', body('100.00'), iv.version, 'r', ME)).code).toBe('doc.settled');
    reverseSettlement(st, 'co-nonvat', s.id, ME);
    expect(revise(st, 'iv-1', body('130.00'), doc('iv-1').version, 'r', ME).totals.total).toBe('5200.00');
    expect(checkInvariants(st)).toEqual([]);
  });
  it('a bill with a settlement cannot be revised to another total', () => {
    const s = postSettlement(st, CO, { kind: 'apply_prepayment', date: DAY, partyId: 'pv-05', sources: [{ docId: 'pv-prep', amount: '500.00' }], targets: [{ docId: 'pb-prep', amount: '500.00' }] }, ME);
    const pb = doc('pb-prep');
    const body = { header: pb.header as DocHeader, lines: pb.lines.map((l) => ({ ...l, unitPrice: '2000.00' })) };
    expect(['doc.settled', 'pb.settled_locked']).toContain(err(() => revise(st, 'pb-prep', body, pb.version, 'r', ME)).code);
    reverseSettlement(st, CO, s.id, ME);
    expect(revise(st, 'pb-prep', body, doc('pb-prep').version, 'r', ME).totals.total).toBe('2140.00');
  });
});

describe('vendor prepayment and WHT', () => {
  it('a voucher with a prepayment posts Dr 1140, its cash includes it and GL 1140 = the unapplied prepayments', () => {
    const pv = doc('pv-prep');
    expect(pv.totals).toMatchObject({ total: '3000.00', cash: '3000.00' });
    expect(pv.header.depositAmount).toBe('3000.00');
    expect(gl('1140')).toBe(300000);
    expect(pv.allocations ?? []).toEqual([]);
    const j = st.journals.find((x) => x.docId === 'pv-prep')!.preview.entries[0];
    expect(j.lines.map((l) => [l.accountCode, l.debit, l.credit, l.partyName])).toEqual([['1140', '3000.00', '0.00', pv.party!.name], ['1121', '0.00', '3000.00', undefined]]);
    expect(checkInvariants(st)).toEqual([]);
  });
  it('applying it to a bill of the vendor clears the payable and the prepayment', () => {
    const ap = gl('2110');
    const s = postSettlement(st, CO, { kind: 'apply_prepayment', date: DAY, partyId: 'pv-05', sources: [{ docId: 'pv-prep', amount: '1070.00' }], targets: [{ docId: 'pb-prep', amount: '1070.00' }] }, ME);
    expect(s.journal[0].lines.map((l) => [l.accountCode, l.debit, l.credit])).toEqual([['2110', '1070.00', '0.00'], ['1140', '0.00', '1070.00']]);
    expect(doc('pb-prep')).toMatchObject({ outstanding: '0.00', status: 'settled' });
    expect(gl('1140')).toBe(193000);
    expect(gl('2110') - ap).toBe(107000);
    assertBalanced(st);
    reverseSettlement(st, CO, s.id, ME);
    expect(gl('1140')).toBe(300000);
    expect(doc('pb-prep').outstanding).toBe('1070.00');
    expect(checkInvariants(st)).toEqual([]);
  });
  it('a bill with a WHT-typed line is not settled without cash: settle.prepayment_wht, nothing written', () => {
    const typed = st.docs.find((d) => d.type === 'PB' && d.id === 'pb-claim-late')!;
    expect(typed.lines.some((l) => l.whtTypeCode)).toBe(true);
    const pv = prepay('pv-02', '500.00');
    const e = err(() => postSettlement(st, CO, { kind: 'apply_prepayment', date: DAY, partyId: 'pv-02', sources: [{ docId: pv, amount: '500.00' }], targets: [{ docId: 'pb-claim-late', amount: '500.00' }] }, ME));
    expect(e.code).toBe('settle.prepayment_wht');
    expect(st.settlements).toHaveLength(1);
    expect(doc('pb-claim-late').outstanding).toBe(typed.totals.total);
  });
  it('the same refusal for a typed bill on either side of a netting and for a write-off of it', () => {
    const d = createDraft(st, CO, 'PB', { header: { partyId: 'pv-11', documentDate: DAY, vendorDocNumber: 'PT-9001', vendorDocDate: DAY }, lines: [{ id: 'x-l1', itemId: 'EXP-05', description: 'ค่าถ่ายภาพ', qty: '1', unit: 'งาน', unitPrice: '1000.00', taxCode: 'S7', expenseCategory: 'services' }] }, ME, 'k-typed-pb');
    const typed = issue(st, d.id, d.version, ME).id;
    expect(doc(typed).lines.some((l) => l.whtTypeCode)).toBe(true);
    expect(err(() => postSettlement(st, CO, { kind: 'netting', date: DAY, partyId: 'pc-02', sources: [{ docId: typed, amount: '500.00' }], targets: [{ docId: 'ti-net', amount: '500.00' }] }, ME)).code).toBe('settle.prepayment_wht');
    expect(err(() => postSettlement(st, CO, { kind: 'write_off', date: DAY, partyId: 'pv-11', targets: [{ docId: typed, amount: '0.50' }], difference: { role: 'RoundingDifference', amount: '0.50' } }, ME)).code).toBe('settle.prepayment_wht');
    expect(st.settlements).toHaveLength(1);
  });
  it('a payable is written off Dr 2110 / Cr the difference role', () => {
    const w = postSettlement(st, CO, { kind: 'write_off', date: DAY, partyId: 'pv-05', targets: [{ docId: 'pb-prep', amount: '0.80' }], difference: { role: 'RoundingDifference', amount: '0.80' } }, ME);
    expect(w.journal[0].lines.map((l) => [l.accountCode, l.debit, l.credit])).toEqual([['2110', '0.80', '0.00'], ['5210', '0.00', '0.80']]);
    expect(doc('pb-prep').outstanding).toBe('1069.20');
    assertBalanced(st);
  });
  it('refuses the wrong sides: a customer deposit to a bill, a prepayment to an invoice', () => {
    expect(err(() => postSettlement(st, CO, { kind: 'apply_prepayment', date: DAY, partyId: 'pv-05', sources: [{ docId: 'pv-prep', amount: '100.00' }], targets: [{ docId: 'ti-dep', amount: '100.00' }] }, ME)).code).toBe('settle.wrong_type');
    expect(err(() => postSettlement(st, CO, { kind: 'apply_prepayment', date: DAY, partyId: 'pv-05', sources: [{ docId: 'rc-dep', amount: '100.00' }], targets: [{ docId: 'pb-prep', amount: '100.00' }] }, ME)).code).toBe('settle.wrong_type');
  });
});

describe('netting', () => {
  const net = (amount = '4280.00', party = 'pc-02'): SettleRequest => ({ kind: 'netting', date: DAY, partyId: party, sources: [{ docId: 'pb-net', amount }], targets: [{ docId: 'ti-net', amount }] });
  it('clears equal AR and AP of the linked pair, in either direction of the link', () => {
    const ar = gl('1130'), ap = gl('2110');
    const s = postSettlement(st, CO, net(), ME);
    expect(s).toMatchObject({ partyId: 'pc-02', counterPartyId: 'pv-11' });
    expect(s.journal[0].lines.map((l) => [l.accountCode, l.debit, l.credit])).toEqual([['2110', '4280.00', '0.00'], ['1130', '0.00', '4280.00']]);
    expect(gl('1130') - ar).toBe(-428000);
    expect(gl('2110') - ap).toBe(428000);
    expect(doc('pb-net')).toMatchObject({ outstanding: '0.00', status: 'settled' });
    expect(doc('ti-net')).toMatchObject({ outstanding: '6420.00', status: 'partly_settled' });
    assertBalanced(st);
    reverseSettlement(st, CO, s.id, ME);
    expect(postSettlement(st, CO, net('1000.00', 'pv-11'), ME).partyId).toBe('pc-02'); // named from the vendor side
    expect(checkInvariants(st)).toEqual([]);
  });
  it('the pair is linked either way: one side naming the other is enough, none is refused', () => {
    delete st.parties.find((p) => p.id === 'pv-11')!.linkedPartyId; // only the customer names the vendor
    expect(postSettlement(st, CO, net('1000.00', 'pv-11'), ME).partyId).toBe('pc-02');
    expect(postSettlement(st, CO, net('1000.00', 'pc-02'), ME).counterPartyId).toBe('pv-11');
    delete st.parties.find((p) => p.id === 'pc-02')!.linkedPartyId; // nobody does
    expect(err(() => postSettlement(st, CO, net('1000.00', 'pv-11'), ME)).code).toBe('settle.not_linked');
    expect(err(() => postSettlement(st, CO, net('1000.00', 'pc-02'), ME)).code).toBe('settle.not_linked');
  });
  it('refuses unequal sides, parties that are not a linked pair, and a difference', () => {
    expect(err(() => postSettlement(st, CO, { ...net(), targets: [{ docId: 'ti-net', amount: '4000.00' }] }, ME)).code).toBe('settle.netting_unbalanced');
    expect(err(() => postSettlement(st, CO, net('4280.00', 'pc-01'), ME)).code).toBe('settle.not_linked');
    expect(err(() => postSettlement(st, CO, { ...net(), difference: { role: 'RoundingDifference', amount: '0.50' } }, ME)).code).toBe('settle.netting_difference');
    expect(err(() => postSettlement(st, CO, { ...net(), sources: [{ docId: 'pb-prep', amount: '4280.00' }] }, ME)).code).toBe('settle.party_mismatch');
    expect(st.settlements).toHaveLength(1);
  });
});

describe('every money invariant fails on a tampered state', () => {
  it('netting: AR cleared = AP cleared', () => {
    const s = postSettlement(st, CO, { kind: 'netting', date: DAY, partyId: 'pc-02', sources: [{ docId: 'pb-net', amount: '4280.00' }], targets: [{ docId: 'ti-net', amount: '4280.00' }] }, ME);
    expect(checkInvariants(st)).toEqual([]);
    st.settlements.find((x) => x.id === s.id)!.sources[0].amount = '4000.00';
    expect(checkInvariants(st).some((m) => m.includes('netting clears AR 4280.00 but AP 4000.00'))).toBe(true);
  });
  it('a target outstanding follows its settlement links (§7.11)', () => {
    postSettlement(st, CO, deposit(), ME);
    expect(checkInvariants(st)).toEqual([]);
    st.links.find((l) => l.from === 'stl-002' && l.to === 'ti-dep')!.amount = '3000.00';
    expect(checkInvariants(st).some((m) => m.includes('ti-dep: outstanding 0.00 but the links say 210.00'))).toBe(true);
  });
  it('GL(2140) = Σ unapplied customer deposits, per party', () => {
    expect(checkInvariants(st)).toEqual([]);
    doc('rc-dep2').header = { ...doc('rc-dep2').header, depositAmount: '2500.00' };
    const bad = checkInvariants(st);
    expect(bad.some((m) => m.includes('GL 2140 (CustomerDeposit)'))).toBe(true);
    expect(bad.some((m) => m.includes('GL 2140 of'))).toBe(true);
  });
  it('GL(1140) = Σ unapplied vendor prepayments, per party', () => {
    doc('pv-prep').header = { ...doc('pv-prep').header, depositAmount: '2500.00' };
    const bad = checkInvariants(st);
    expect(bad.some((m) => m.includes('GL 1140 (VendorPrepayment)'))).toBe(true);
    expect(bad.some((m) => m.includes('GL 1140 of'))).toBe(true);
  });
  it('the PV balance identity includes the prepayment', () => {
    const pv = doc('pv-prep');
    pv.totals = { ...pv.totals, total: '2500.00' };
    expect(checkInvariants(st).some((m) => m.includes('pv-prep: PV total 2500.00 is not Σ allocations + line totals + prepayment (3000.00)'))).toBe(true);
  });
  it('a settlement journal balances', () => {
    postSettlement(st, CO, deposit(), ME);
    st.settlements.find((x) => x.id === 'stl-002')!.journal[0].lines[0].debit = '3200.00';
    expect(checkInvariants(st).some((m) => m.includes('settlement stl-002') && m.includes('unbalanced'))).toBe(true);
  });
  it('a reversed settlement leaves no active link', () => {
    const s = postSettlement(st, CO, deposit(), ME);
    reverseSettlement(st, CO, s.id, ME);
    expect(checkInvariants(st)).toEqual([]);
    st.links.find((l) => l.from === s.id && l.to === 'ti-dep')!.active = true;
    const bad = checkInvariants(st);
    expect(bad.some((m) => m.includes('reversed but 1 settles link(s) are still active'))).toBe(true);
    expect(bad.some((m) => m.includes('is active but stl-002 is reversed'))).toBe(true);
  });
  it('a deposit is never applied beyond what it kept', () => {
    postSettlement(st, CO, deposit(), ME);
    doc('rc-dep').header = { ...doc('rc-dep').header, depositAmount: '3000.00' };
    expect(checkInvariants(st).some((m) => m.includes('rc-dep: 3210.00 applied from a deposit of 3000.00'))).toBe(true);
  });
});
