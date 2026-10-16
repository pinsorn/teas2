import { describe, expect, it } from 'vitest';
import type { Allocation, DocHeader, DocLine } from '@/domain/types';
import { USER as U } from '../fixtures/documents';
import { fixtureIds } from '../fixtures/ids';
import { buildSeedState, type MockState } from '../store';
import { cancel, compute, createDraft, issue, revise } from './commands';
import { correctionPlan, executePlan } from './corrections';
import { checkInvariants, whtLineProblems } from './invariants';
import { toSatang } from './money';
import { assertBalanced } from './test-helpers';

const msgs = (st: MockState) => checkInvariants(st).join('\n');
const hdr = (partyId: string, p: Partial<DocHeader> = {}): DocHeader => ({ partyId, documentDate: '2026-10-14', ...p });
const ln = (p: Partial<DocLine> = {}): DocLine => ({ id: 'l1', description: 'ค่าบริการ', qty: '1', unit: 'งาน', unitPrice: '1000.00', taxCode: 'EX', ...p });
const out = (st: MockState, id: string) => toSatang(st.docs.find((d) => d.id === id)!.outstanding!);
const rcOf = (st: MockState, allocations: Allocation[], header = hdr('pc-01'), key = 'r') => {
  const d = createDraft(st, 'co-vat', 'RC', { header, lines: [], allocations }, U, key);
  return issue(st, d.id, d.version, U);
};
/** An issued, unpaid TI of a customer other than pc-01. */
const otherTi = (st: MockState) => st.docs.find((d) => d.type === 'TI' && d.status === 'issued' && d.header.partyId !== 'pc-01' && d.outstanding === d.totals.total)!;

describe('1: the cross-party exception is only for retargeted invoices of a correction-plan receipt', () => {
  it('correcting the receipt itself to another party invoice is refused (settle.party_mismatch) before a plan is shown and nothing changes', () => {
    const st = buildSeedState();
    const ids = fixtureIds(st);
    const rc = rcOf(st, [{ targetId: ids.rcTargetsA, targetType: 'TI', amount: '100.00' }]);
    const stored = st.docs.find((d) => d.id === rc.id)!;
    const o = otherTi(st);
    // refused when the plan is asked for (S4 fix round 1, M4): a plan that cannot execute is never shown
    expect(() => correctionPlan(st, rc.id, { header: stored.header, lines: [], allocations: [{ targetId: o.id, targetType: 'TI', amount: '100.00' }] }, 'accountant')).toThrow(/settle.party_mismatch/);
    expect(st.docs.find((d) => d.id === rc.id)!.status).toBe('issued');
  });
  it('a retargeted invoice of the corrected TI is still allowed to differ in party, and the other target is not exempted', () => {
    const st = buildSeedState();
    const ids = fixtureIds(st);
    const rc = rcOf(st, [{ targetId: ids.rcTargetsA, targetType: 'TI', amount: '1000.00', wht: '30.00', whtTypeCode: 'SVC' }, { targetId: ids.rcTargetsB, targetType: 'TI', amount: '500.00' }]);
    const a = st.docs.find((d) => d.id === ids.rcTargetsA)!;
    const plan = correctionPlan(st, a.id, { header: { ...a.header, partyId: 'pc-02' }, lines: a.lines }, 'accountant');
    executePlan(st, plan.planId, plan.planHash, U, 'accountant');
    const newRc = st.docs.find((d) => d.replacesId === rc.id)!;
    expect(newRc.header.partyId).toBe('pc-01'); // the receipt keeps its customer; only the moved invoice is exempt
    expect(newRc.allocations!.map((x) => x.partyId)).toEqual(['pc-02', 'pc-01']);
  });
});

describe('2: AR is credited per allocation under the target party; the 50 tawi stays with the party who withheld', () => {
  it('journal AR lines are split by target party and the per-party AR subledger invariant holds; a mis-labelled line is reported', () => {
    const st = buildSeedState();
    const ids = fixtureIds(st);
    const rc = rcOf(st, [{ targetId: ids.rcTargetsA, targetType: 'TI', amount: '1000.00', wht: '30.00', whtTypeCode: 'SVC', certNumber: 'ท.2569/0451' }, { targetId: ids.rcTargetsB, targetType: 'TI', amount: '500.00' }]);
    const a = st.docs.find((d) => d.id === ids.rcTargetsA)!;
    const plan = correctionPlan(st, a.id, { header: { ...a.header, partyId: 'pc-02' }, lines: a.lines }, 'accountant');
    executePlan(st, plan.planId, plan.planHash, U, 'accountant');
    const newRc = st.docs.find((d) => d.replacesId === rc.id)!;
    const ar = st.journals.find((j) => j.docId === newRc.id)!.preview.entries[0].lines.filter((l) => l.accountCode === '1130');
    expect(ar.map((l) => [l.partyName, l.credit])).toEqual([['บริษัท ปิ่นทองการพิมพ์ จำกัด', '1000.00'], ['บริษัท นาวาพาณิชย์ จำกัด', '500.00']]);
    expect(newRc.allocations![0]).toMatchObject({ partyId: 'pc-02', certNumber: 'ท.2569/0451', wht: '30.00' }); // the certificate follows the invoice's party
    assertBalanced(st);
    ar[0].partyName = 'บริษัท นาวาพาณิชย์ จำกัด'; // same account, same totals, wrong customer ledger
    expect(msgs(st)).toMatch(/AR 1130 of .*: GL .* but outstanding/);
  });
});

describe('3: negative deposit and negative cash are refused', () => {
  it('rc.invalid_deposit for a negative deposit (issue and compute); a PV whose cash would be negative is refused', () => {
    const st = buildSeedState();
    const a = fixtureIds(st).rcTargetsA;
    const body = { header: hdr('pc-01', { depositAmount: '-2000.00' }), lines: [], allocations: [{ targetId: a, targetType: 'TI' as const, amount: '1000.00' }] };
    expect(compute(st, 'co-vat', 'RC', body).missing.map((m) => m.message).join()).toMatch(/เงินรับล่วงหน้า/);
    const d = createDraft(st, 'co-vat', 'RC', body, U, 'neg');
    expect(() => issue(st, d.id, d.version, U)).toThrow(/rc.invalid_deposit/);
    const pv = createDraft(st, 'co-vat', 'PV', { header: hdr('pv-01'), lines: [ln({ unitPrice: '-100.00' })] }, U, 'negpv');
    expect(() => issue(st, pv.id, pv.version, U)).toThrow(/pay.negative_cash/);
  });
});

describe('4: compute in revise mode gives back the document own links', () => {
  it('a receipt that fully paid a TI: compute with the document id is ready; without it the same allocation is over-allocated', () => {
    const st = buildSeedState();
    const a = st.docs.find((d) => d.id === fixtureIds(st).rcTargetsA)!;
    const rc = rcOf(st, [{ targetId: a.id, targetType: 'TI', amount: a.outstanding!, wht: '10.00' }]); // a certificate needs withheld tax (M3)
    expect(out(st, a.id)).toBe(0);
    const withCert = rc.allocations!.map((x) => ({ ...x, certNumber: 'ท.2569/0451' }));
    const body = { header: rc.header, lines: [], allocations: withCert };
    expect(compute(st, 'co-vat', 'RC', body).missing.map((m) => m.field)).toContain('allocations');
    expect(compute(st, 'co-vat', 'RC', body, { docId: rc.id }).missing).toEqual([]);
    expect(revise(st, rc.id, body, rc.version, 'บันทึกเลขที่หนังสือรับรอง', U).allocations![0].certNumber).toBe('ท.2569/0451');
  });
});

describe('5: a debit note cancelled after payment leaves a negative outstanding (customer credit) and every invariant holds', () => {
  it('pay TI, DN, pay the DN, cancel the DN -> negative outstanding, no violation', () => {
    const st = buildSeedState();
    const a = st.docs.find((d) => d.id === fixtureIds(st).rcTargetsA)!;
    rcOf(st, [{ targetId: a.id, targetType: 'TI', amount: a.outstanding! }], hdr('pc-01'), 'p1');
    const dn = createDraft(st, 'co-vat', 'DN', { header: hdr('pc-01', { refDocId: a.id, reasonCode: 'PRICE_INCREASE' }), lines: [ln({ taxCode: 'S7' })] }, U, 'dn');
    const dnDone = issue(st, dn.id, dn.version, U); // issue links the note to its invoice
    expect(out(st, a.id)).toBe(107000);
    rcOf(st, [{ targetId: a.id, targetType: 'TI', amount: '1070.00' }], hdr('pc-01'), 'p2');
    expect(out(st, a.id)).toBe(0);
    cancel(st, dnDone.id, dnDone.version, 'OTHER', 'x', U);
    expect(out(st, a.id)).toBe(-107000);
    expect(msgs(st)).toBe('');
  });
});

describe('6: input VAT only via a bill: PV amount lines are exempt-only', () => {
  it.each(['S7', 'Z0'] as const)('a PV line with %s is refused (pv.input_vat_needs_bill) and compute reports it', (taxCode) => {
    const st = buildSeedState();
    const body = { header: hdr('pv-01'), lines: [ln({ taxCode })] };
    expect(compute(st, 'co-vat', 'PV', body).missing.map((m) => m.message).join()).toMatch(/บันทึกซื้อ \(มีใบกำกับภาษี\)/);
    const d = createDraft(st, 'co-vat', 'PV', body, U, `vat-${taxCode}`);
    expect(() => issue(st, d.id, d.version, U)).toThrow(/pv.input_vat_needs_bill/);
  });
});

describe('M1: WHT lines are checked against an independent recomputation', () => {
  const line = { code: 'SVC', nameTh: 'ค่าบริการ', form: 'PND53' as const, base: '5000.00', rate: '3%', tax: '154.50', income: '5150.00', net: '4995.50' };
  it('a correct once line passes; a wrong net, tax or income is reported', () => {
    expect(whtLineProblems(line, 500000, 300n, 'grossup_once')).toEqual([]);
    expect(whtLineProblems({ ...line, net: '5000.00' }, 500000, 300n, 'grossup_once').join()).toMatch(/payee/);
    expect(whtLineProblems({ ...line, tax: '154.51' }, 500000, 300n, 'grossup_once').join()).toMatch(/tax/);
    expect(whtLineProblems({ ...line, income: '5151.00' }, 500000, 300n, 'grossup_once').join()).toMatch(/income/);
  });
});

describe('M2: bank account and cash', () => {
  it('a bank account of another company is refused; paymentMethod cash posts to the cash account 1110', () => {
    const st = buildSeedState();
    const a = fixtureIds(st).rcTargetsA;
    const alloc = [{ targetId: a, targetType: 'TI' as const, amount: '100.00' }];
    const bad = createDraft(st, 'co-vat', 'RC', { header: hdr('pc-01', { bankAccountId: 'nba-kbank' }), lines: [], allocations: alloc }, U, 'bk');
    expect(() => issue(st, bad.id, bad.version, U)).toThrow(/pay.invalid_bank_account/);
    const cash = rcOf(st, alloc, hdr('pc-01', { paymentMethod: 'cash' }), 'cash');
    expect(st.journals.find((j) => j.docId === cash.id)!.preview.entries[0].lines.find((l) => l.debit !== '0.00' && l.accountCode.startsWith('11') && l.accountCode !== '1180')?.accountCode).toBe('1110');
  });
});

describe('M3: per-allocation WHT and the WHT type code', () => {
  it('one allocation withholding more than its own amount is refused even when the sum is fine; an unknown type code is refused', () => {
    const st = buildSeedState();
    const ids = fixtureIds(st);
    const a = createDraft(st, 'co-vat', 'RC', { header: hdr('pc-01'), lines: [], allocations: [
      { targetId: ids.rcTargetsA, targetType: 'TI', amount: '100.00', wht: '150.00' }, { targetId: ids.rcTargetsB, targetType: 'TI', amount: '500.00' }] }, U, 'w1');
    expect(() => issue(st, a.id, a.version, U)).toThrow(/rc.wht_exceeds_amount/);
    const b = createDraft(st, 'co-vat', 'RC', { header: hdr('pc-01'), lines: [], allocations: [{ targetId: ids.rcTargetsA, targetType: 'TI', amount: '100.00', wht: '3.00', whtTypeCode: 'NOPE' }] }, U, 'w2');
    expect(() => issue(st, b.id, b.version, U)).toThrow(/wht.unknown_type/);
  });
});

describe('M4: the invariant agrees with the engine on an unknown code with a non-positive base', () => {
  it('a zero-base line with an unknown WHT type is not a violation', () => {
    const st = buildSeedState();
    const d = createDraft(st, 'co-vat', 'PV', { header: hdr('pv-01'), lines: [ln({ whtTypeCode: 'SVC' })] }, U, 'm4');
    const done = issue(st, d.id, d.version, U);
    st.docs.find((x) => x.id === done.id)!.lines.push(ln({ id: 'l2', unitPrice: '0.00', whtTypeCode: 'NOPE' }));
    expect(msgs(st)).toBe('');
  });
});
