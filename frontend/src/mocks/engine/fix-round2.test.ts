import { describe, expect, it } from 'vitest';
import type { DocHeader, DocLine } from '@/domain/types';
import { USER as U } from '../fixtures/documents';
import { fixtureIds } from '../fixtures/ids';
import { buildSeedState, type MockState } from '../store';
import { cancel, compute, createDraft, issue, revise } from './commands';
import { correctionPlan, executePlan } from './corrections';
import { checkInvariants } from './invariants';
import { toSatang } from './money';

const hdr = (partyId: string, p: Partial<DocHeader> = {}): DocHeader => ({ partyId, documentDate: '2026-10-14', ...p });
const ln = (p: Partial<DocLine> = {}): DocLine => ({ id: 'l1', description: 'ค่าบริการ', qty: '1', unit: 'งาน', unitPrice: '1000.00', taxCode: 'EX', ...p });
const get = (st: MockState, id: string) => st.docs.find((d) => d.id === id)!;
const out = (st: MockState, id: string) => toSatang(get(st, id).outstanding!);
const rcOf = (st: MockState, allocations: object[], header = hdr('pc-01'), key = 'r') => {
  const d = createDraft(st, 'co-vat', 'RC', { header, lines: [], allocations } as never, U, key);
  return issue(st, d.id, d.version, U);
};
const correct = (st: MockState, id: string, patch: (d: ReturnType<typeof get>) => object) => {
  const d = get(st, id);
  const plan = correctionPlan(st, id, { header: d.header, lines: d.lines, ...patch(d) } as never, 'accountant');
  executePlan(st, plan.planId, plan.planHash, U, 'accountant');
};
const CERT = 'ท.2569/0451';

describe('N1: a legitimate mixed-party receipt survives the correction of its other invoice', () => {
  it('RC(A,B) -> correct A to pc-02 -> correct B (same total): both settlements kept, WHT metadata kept, invariants clean', () => {
    const st = buildSeedState();
    const ids = fixtureIds(st);
    const rc = rcOf(st, [{ targetId: ids.rcTargetsA, targetType: 'TI', amount: '1000.00', wht: '30.00', whtTypeCode: 'SVC', certNumber: CERT }, { targetId: ids.rcTargetsB, targetType: 'TI', amount: '500.00' }]);
    correct(st, ids.rcTargetsA, (a) => ({ header: { ...a.header, partyId: 'pc-02' } }));
    const rc2 = st.docs.find((d) => d.replacesId === rc.id)!;
    correct(st, ids.rcTargetsB, (b) => ({ lines: b.lines.map((l, i) => (i === 0 ? { ...l, description: l.description + ' (แก้)' } : l)) }));
    const rc3 = st.docs.find((d) => d.replacesId === rc2.id)!;
    expect(rc3.allocations!.map((x) => [x.partyId, x.amount, x.wht, x.certNumber])).toEqual([['pc-02', '1000.00', '30.00', CERT], ['pc-01', '500.00', undefined, undefined]]);
    expect(checkInvariants(st)).toEqual([]);
  });
  it('a NEW allocation to another party is still refused on the same receipt (revise-time compute)', () => {
    const st = buildSeedState();
    const ids = fixtureIds(st);
    const rc = rcOf(st, [{ targetId: ids.rcTargetsA, targetType: 'TI', amount: '100.00' }]);
    const o = st.docs.find((d) => d.type === 'TI' && d.status === 'issued' && d.header.partyId !== 'pc-01' && d.outstanding === d.totals.total)!;
    const m = compute(st, 'co-vat', 'RC', { header: rc.header, lines: [], allocations: [...rc.allocations!, { targetId: o.id, targetType: 'TI', amount: '100.00' }] }, { docId: rc.id }).missing;
    expect(m.map((x) => x.field)).toContain('allocations');
  });
});

describe('finding 4 residual: compute / revise of an existing mixed-party or credit-state RC', () => {
  it('certificate-only change on a mixed-party RC is ready in compute and accepted by revise', () => {
    const st = buildSeedState();
    const ids = fixtureIds(st);
    const rc = rcOf(st, [{ targetId: ids.rcTargetsA, targetType: 'TI', amount: '1000.00', wht: '30.00', whtTypeCode: 'SVC' }, { targetId: ids.rcTargetsB, targetType: 'TI', amount: '500.00' }]);
    correct(st, ids.rcTargetsA, (a) => ({ header: { ...a.header, partyId: 'pc-02' } }));
    const rc2 = st.docs.find((d) => d.replacesId === rc.id)!;
    const al = rc2.allocations!.map((x, i) => (i === 0 ? { ...x, certNumber: 'ท.2569/0999' } : x));
    expect(compute(st, 'co-vat', 'RC', { header: rc2.header, lines: [], allocations: al }, { docId: rc2.id }).missing).toEqual([]);
    expect(revise(st, rc2.id, { header: rc2.header, lines: [], allocations: al }, rc2.version, 'cert', U).allocations![0].certNumber).toBe('ท.2569/0999');
  });
  it('certificate-only change after a cancelled DN left a customer credit is allowed; a changed amount is still checked', () => {
    const st = buildSeedState();
    const a = get(st, fixtureIds(st).rcTargetsA);
    rcOf(st, [{ targetId: a.id, targetType: 'TI', amount: a.outstanding! }], hdr('pc-01'), 'p1');
    const dn = createDraft(st, 'co-vat', 'DN', { header: hdr('pc-01', { refDocId: a.id, reasonCode: 'PRICE_INCREASE' }), lines: [ln({ taxCode: 'S7' })] }, U, 'dn');
    const dnDone = issue(st, dn.id, dn.version, U); // issue links the note to its invoice
    const rc2 = rcOf(st, [{ targetId: a.id, targetType: 'TI', amount: '1070.00', wht: '10.00' }], hdr('pc-01'), 'p2'); // a certificate needs withheld tax (M3)
    cancel(st, dnDone.id, dnDone.version, 'OTHER', 'x', U);
    expect(out(st, a.id)).toBe(-107000);
    const al = rc2.allocations!.map((x) => ({ ...x, certNumber: CERT }));
    expect(compute(st, 'co-vat', 'RC', { header: rc2.header, lines: [], allocations: al }, { docId: rc2.id }).missing).toEqual([]);
    expect(revise(st, rc2.id, { header: rc2.header, lines: [], allocations: al }, rc2.version, 'cert', U).allocations![0].certNumber).toBe(CERT);
    const bigger = rc2.allocations!.map((x) => ({ ...x, amount: '2000.00' }));
    expect(compute(st, 'co-vat', 'RC', { header: rc2.header, lines: [], allocations: bigger }, { docId: rc2.id }).missing.map((x) => x.field)).toContain('allocations');
  });
});

describe('N2: paymentMethod is a fiscal change', () => {
  it('transfer -> cash goes through the correction plan: journal reversed and reposted to 1110', () => {
    const st = buildSeedState();
    const a = fixtureIds(st).rcTargetsA;
    const rc = rcOf(st, [{ targetId: a, targetType: 'TI', amount: '100.00' }], hdr('pc-01', { paymentMethod: 'transfer' }));
    expect(() => revise(st, rc.id, { header: { ...rc.header, paymentMethod: 'cash' }, lines: [], allocations: rc.allocations }, rc.version, 'x', U)).toThrow(/doc.revise_not_allowed/);
    correct(st, rc.id, (d) => ({ header: { ...d.header, paymentMethod: 'cash' }, allocations: d.allocations }));
    const rc2 = st.docs.find((d) => d.replacesId === rc.id)!;
    const debitAcct = (id: string) => st.journals.find((j) => j.docId === id)!.preview.entries.flatMap((e) => e.lines).filter((l) => l.debit !== '0.00' && /^11[12]/.test(l.accountCode)).map((l) => l.accountCode);
    expect(debitAcct(rc.id)).toContain('1121');
    expect(debitAcct(rc2.id)).toEqual(['1110']);
    expect(checkInvariants(st)).toEqual([]);
  });
});

describe('M3 residual: a supplied whtTypeCode is validated even when wht is 0', () => {
  it('unknown code with wht 0 is refused', () => {
    const st = buildSeedState();
    const a = fixtureIds(st).rcTargetsA;
    const d = createDraft(st, 'co-vat', 'RC', { header: hdr('pc-01'), lines: [], allocations: [{ targetId: a, targetType: 'TI', amount: '100.00', wht: '0.00', whtTypeCode: 'NOPE' }] }, U, 'm3');
    expect(() => issue(st, d.id, d.version, U)).toThrow(/wht.unknown_type/);
  });
});
