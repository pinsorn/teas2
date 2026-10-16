import { describe, expect, it } from 'vitest';
import type { Allocation, DocLine } from '@/domain/types';
import { USER as me } from '../fixtures/documents';
import { buildSeedState, type MockState } from '../store';
import { approveAndIssue, compute, createDraft, issue, revise } from './commands';
import { checkInvariants } from './invariants';
import { MockError } from './log';

/** GP fix round: the approved amount is what the company pays out (P4 m1), retargeting after approval (P4 m2), the withholding base never exceeds the voucher's own payment (P3 R2-M2). */
const L = (id: string, taxCode: DocLine['taxCode'], unitPrice: string, p: Partial<DocLine> = {}): DocLine => ({ id, description: `x ${id}`, qty: '1', unit: 'u', unitPrice, taxCode, expenseCategory: 'services', ...p });
const err = (f: () => unknown): MockError => { try { f(); } catch (e) { return e as MockError; } throw new Error('did not throw'); };
const g = (st: MockState, id: string) => st.docs.find((x) => x.id === id)!;
let n = 0; const k = () => `gp-${n++}`;
const other = { ...me, id: 'u-2', name: 'Other' };
const pb = (st: MockState, lines: DocLine[]) => { const d = createDraft(st, 'co-vat', 'PB', { header: { partyId: 'pv-03', documentDate: '2026-10-14' }, lines }, me, k()); issue(st, d.id, d.version, me); return d.id; };
const svc = (price: string) => L('s', 'S7', price, { whtTypeCode: 'SVC' });
const alloc = (b: string, amount: string): Allocation => ({ targetId: b, targetType: 'PB', amount });
const pvDraft = (st: MockState, allocations: Allocation[], whtMode?: 'deduct' | 'grossup_always' | 'grossup_once') =>
  createDraft(st, 'co-vat', 'PV', { header: { partyId: 'pv-03', documentDate: '2026-10-14', ...(whtMode ? { whtMode } : {}) }, lines: [], allocations }, me, k());
const pvApproved = (st: MockState, allocations: Allocation[], whtMode?: 'deduct' | 'grossup_always' | 'grossup_once') => { const d = pvDraft(st, allocations, whtMode); return approveAndIssue(st, d.id, d.version, me); };

describe('m1: the approved amount is total + the WHT the company bears', () => {
  it('R2: switching to a gross-up mode after approval needs an approver (same total, more money out)', () => {
    const st = buildSeedState();
    const b = pb(st, [svc('60000.00')]);
    const p = pvApproved(st, [alloc(b, '64200.00')], 'deduct');
    expect(g(st, p.id).approval?.amount).toBe('64200.00');
    const x = g(st, p.id);
    const body = { header: { ...x.header, whtMode: 'grossup_always' as const }, lines: [], allocations: x.allocations };
    expect(compute(st, 'co-vat', 'PV', body, { docId: x.id }).approvalRequired).toBe(true);
    expect(err(() => revise(st, x.id, body, x.version, 'r', other)).code).toBe('approval.required_on_revise');
    revise(st, x.id, body, x.version, 'r', other, { approver: me });
    const y = g(st, p.id);
    expect(y.whtFrozen?.expense).toBe('1855.67');
    expect(y.approval).toMatchObject({ approvedBy: { id: 'u-1' }, amount: '66055.67' });
    expect(checkInvariants(st)).toEqual([]);
    y.approval!.amount = '64200.00'; // tampered back to the settled total
    expect(checkInvariants(st).join('\n')).toContain('covers only 64200.00');
  });
  it('a gross-up voucher whose payout is above the minimum needs approval at first issue, a deduct one of the same total does not', () => {
    const st = buildSeedState();
    const b = pb(st, [svc('46261.68')]); // 49,500.00 with VAT
    const d = pvDraft(st, [alloc(b, '49500.00')], 'grossup_always');
    expect(g(st, d.id).totals.total).toBe('49500.00');
    expect(err(() => issue(st, d.id, d.version, me)).code).toBe('approval.required');
    const e = pvDraft(st, [alloc(b, '49500.00')], 'deduct');
    expect(issue(st, e.id, e.version, me).status).toBe('issued');
  });
});

describe('m2: after approval, which documents a gated voucher pays is part of the approval', () => {
  it('R3: retargeting at the same total needs an approver; the same target at a lower amount stays free', () => {
    const st = buildSeedState();
    const b1 = pb(st, [svc('60000.00')]), b2 = pb(st, [svc('60000.00')]);
    const p = pvApproved(st, [alloc(b1, '64200.00')]);
    const x = g(st, p.id);
    const to = (b: string, amount: string) => ({ header: x.header, lines: [], allocations: [alloc(b, amount)] });
    expect(compute(st, 'co-vat', 'PV', to(b2, '64200.00'), { docId: x.id }).approvalRequired).toBe(true);
    expect(err(() => revise(st, x.id, to(b2, '64200.00'), x.version, 'r', other)).code).toBe('approval.required_on_revise');
    expect(err(() => revise(st, x.id, to(b2, '51000.00'), x.version, 'r', other)).code).toBe('approval.required_on_revise'); // lower, but a different bill
    revise(st, x.id, to(b1, '51000.00'), x.version, 'r', other); // same bill, less money: free
    const y = g(st, p.id);
    expect(y.approval?.amount).toBe('64200.00');
    revise(st, y.id, to(b2, '64200.00'), y.version, 'r', other, { approver: me });
    expect(g(st, p.id).approval).toMatchObject({ approvedBy: { id: 'u-1' }, amount: '64200.00' });
    expect(g(st, p.id).allocations?.[0].targetId).toBe(b2);
    expect(checkInvariants(st)).toEqual([]);
  });
});

describe('GP-I1: each voucher withholds on its own share of what the bill still owed; the paying-up voucher takes the remainder', () => {
  const setup = () => {
    const st = buildSeedState();
    const b = pb(st, [svc('10000.00'), L('g', 'S7', '10000.00', { expenseCategory: 'supplies' })]);
    const mk = (amount: string) => { const d = pvDraft(st, [alloc(b, amount)]); return issue(st, d.id, d.version, me).id; };
    const base = (id: string) => g(st, id).whtFrozen!.bases.filter((x) => x.targetId === b).reduce((a, x) => a + Math.round(Number(x.base) * 100), 0) / 100;
    const p1 = mk('21400.00');
    const pdn = createDraft(st, 'co-vat', 'PDN', { header: { documentDate: '2026-10-14', refDocId: b, reasonCode: 'PRICE_INCREASE' }, lines: [L('c', 'S7', '2000.00', { sourceLineId: 's' })] }, me, k());
    issue(st, pdn.id, pdn.version, me);
    const preVat = (id: string) => Math.round(Number(g(st, id).totals.total) * 100 / 1.07) / 100;
    return { st, b, mk, base, p1, preVat };
  };
  it('H2: after a PDN on the service line, 1,000.00 then the rest: 934.58 and 1,065.42, never more than the pre-VAT payment; the sum is exact', () => {
    const { st, b, mk, base, p1, preVat } = setup();
    const p2 = mk('1000.00');
    const p3 = mk(g(st, b).outstanding!);
    expect([base(p2), base(p3)]).toEqual([934.58, 1065.42]);
    for (const id of [p2, p3]) expect(base(id)).toBeLessThanOrEqual(preVat(id) + 0.005);
    expect(base(p1) + base(p2) + base(p3)).toBe(12000);
    expect(checkInvariants(st)).toEqual([]);
  });
  it('H1: a near-full partial, then the last 10.00 in deduct mode: 1,990.65 and 9.35, and the pay-up issues', () => {
    const { st, b, mk, base, preVat } = setup();
    const p2 = mk('2130.00');
    expect(g(st, b).outstanding).toBe('10.00');
    const p3 = mk('10.00');
    expect([base(p2), base(p3)]).toEqual([1990.65, 9.35]);
    for (const id of [p2, p3]) expect(base(id)).toBeLessThanOrEqual(preVat(id) + 0.005);
    expect(g(st, b).status).toBe('settled');
    expect(checkInvariants(st)).toEqual([]);
  });
});
