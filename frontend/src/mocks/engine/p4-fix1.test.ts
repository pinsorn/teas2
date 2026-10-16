import { describe, expect, it } from 'vitest';
import { tinCheckDigit } from '@/domain/tin';
import type { DocLine } from '@/domain/types';
import { USER as me } from '../fixtures/documents';
import { buildSeedState, type MockState } from '../store';
import { approve } from './approval';
import { approveAndIssue, cancel, compute, convert, createDraft, deleteDraft, issue, reissue, revise, submitForApproval, updateDraft } from './commands';
import { buildPlan, correctionPlan, executePlan } from './corrections';
import { checkInvariants } from './invariants';
import { MockError } from './log';

/** SP1c P4 fix round 1 (review-P4-opus): C1 approval covers the amount, I1 employee voucher, I2 self-approval, M1 reissue, M2 full tax invoice, M3 exits. */
const TIN = '010556000123' + tinCheckDigit('010556000123');
const L = (id: string, taxCode: DocLine['taxCode'], unitPrice: string, p: Partial<DocLine> = {}): DocLine => ({ id, description: `x ${id}`, qty: '1', unit: 'u', unitPrice, taxCode, expenseCategory: 'supplies', ...p });
const err = (f: () => unknown): MockError => { try { f(); } catch (e) { return e as MockError; } throw new Error('did not throw'); };
const g = (st: MockState, id: string) => st.docs.find((x) => x.id === id)!;
let n = 0; const k = () => `f1-${n++}`;
const other = { ...me, id: 'u-2', name: 'Other' };
const pb = (st: MockState, price: string) => { const d = createDraft(st, 'co-vat', 'PB', { header: { partyId: 'pv-03', documentDate: '2026-10-14' }, lines: [L('a', 'S7', price)] }, me, k()); issue(st, d.id, d.version, me); return d.id; };
const pvAlloc = (b: string, amount: string) => ({ targetId: b, targetType: 'PB' as const, amount });
const pvBody = (b: string, amount: string) => ({ header: { partyId: 'pv-03', documentDate: '2026-10-14' }, lines: [], allocations: [pvAlloc(b, amount)] });
const exDraft = (st: MockState, price: string, actor = me, party = 'emp-02') => createDraft(st, 'co-vat', 'EX', { header: { partyId: party, documentDate: '2026-10-14' }, lines: [L('a', 'EX', price)] }, actor, k());
const noSelf = (st: MockState) => { st.approvalPolicies = st.approvalPolicies.map((p) => ({ ...p, selfApproval: false })); };

describe('C1: the approval covers the amount', () => {
  it('A: a PV issued under 50,000.00 and revised above it needs an approver in the same command', () => {
    const st = buildSeedState();
    const b = pb(st, '100000.00');
    const d = createDraft(st, 'co-vat', 'PV', pvBody(b, '5000.00'), me, k());
    issue(st, d.id, d.version, me);
    const p = g(st, d.id);
    const up = (approver?: typeof me) => revise(st, p.id, { header: p.header, lines: [], allocations: [pvAlloc(b, '107000.00')] }, p.version, 'x', me, approver ? { approver } : undefined);
    const e = err(() => up());
    expect([e.status, e.code]).toEqual([422, 'approval.required_on_revise']);
    expect(e.title).toContain('ให้ผู้มีสิทธิ์อนุมัติเป็นผู้แก้ไข');
    expect(g(st, d.id).totals.total).toBe('5000.00'); // nothing written
    up(me);
    const x = g(st, d.id);
    expect(x.totals.total).toBe('107000.00');
    expect(x.approval).toMatchObject({ approvedBy: { id: 'u-1' }, amount: '107000.00' });
    expect(st.activity.some((a) => a.docId === d.id && a.action === 'approve' && a.detail === 'อนุมัติการแก้ไข')).toBe(true);
    expect(checkInvariants(st)).toEqual([]);
  });

  it('B: an approved EX revised upward is re-approved (new amount, new approver); lowering or changing no money stays free', () => {
    const st = buildSeedState();
    const d = exDraft(st, '1000.00');
    approveAndIssue(st, d.id, d.version, me);
    let x = g(st, d.id);
    expect(x.approval?.amount).toBe('1000.00');
    const body = (price: string) => ({ header: x.header, lines: [L('a', 'EX', price)] });
    expect(err(() => revise(st, x.id, body('99999.00'), x.version, 'r', other)).code).toBe('approval.required_on_revise');
    revise(st, x.id, body('500.00'), x.version, 'lower', other); // lower: free, the approved amount stays
    x = g(st, d.id);
    expect(x.approval?.amount).toBe('1000.00');
    revise(st, x.id, body('800.00'), x.version, 'within the approved amount', other); // 800 <= 1000: covered
    x = g(st, d.id);
    revise(st, x.id, { header: x.header, lines: [L('a', 'EX', '800.00', { description: 'renamed' })] }, x.version, 'no money', other);
    x = g(st, d.id);
    revise(st, x.id, body('99999.00'), x.version, 'up', other, { approver: me });
    x = g(st, d.id);
    expect(x.approval).toMatchObject({ approvedBy: { id: 'u-1' }, amount: '99999.00' });
    expect(checkInvariants(st)).toEqual([]);
  });

  it('a document issued without approval that now crosses the minimum needs it; below the minimum it does not', () => {
    const st = buildSeedState();
    const b = pb(st, '100000.00');
    const d = createDraft(st, 'co-vat', 'PV', pvBody(b, '5000.00'), me, k());
    issue(st, d.id, d.version, me);
    const p = g(st, d.id);
    revise(st, p.id, { header: p.header, lines: [], allocations: [pvAlloc(b, '50000.00')] }, p.version, 'x', me); // exactly the minimum: not above it
    expect(g(st, d.id).approval).toBeUndefined();
    const q = g(st, d.id);
    expect(err(() => revise(st, q.id, { header: q.header, lines: [], allocations: [pvAlloc(b, '50000.01')] }, q.version, 'x', me)).code).toBe('approval.required_on_revise');
  });

  it('compute in revise mode says approvalRequired exactly when the save would need an approver', () => {
    const st = buildSeedState();
    const d = exDraft(st, '1000.00');
    approveAndIssue(st, d.id, d.version, me);
    const x = g(st, d.id);
    const c = (price: string) => compute(st, 'co-vat', 'EX', { header: x.header, lines: [L('a', 'EX', price)] }, { docId: x.id });
    expect(c('2000.00').approvalRequired).toBe(true);
    expect(c('900.00').approvalRequired).toBeUndefined();
    expect(c('1000.00').approvalRequired).toBeUndefined();
  });

  it('a correction plan that raises the money re-stamps the approval (accountant holds approve); a tampered approval amount is reported', () => {
    const st = buildSeedState();
    const d = exDraft(st, '1000.00');
    approveAndIssue(st, d.id, d.version, me);
    const x = g(st, d.id);
    const proposed = { header: x.header, lines: [L('a', 'EX', '3000.00')] };
    const plan = correctionPlan(st, x.id, proposed, 'accountant');
    executePlan(st, plan.planId, plan.planHash, me, 'accountant');
    expect(g(st, d.id).approval?.amount).toBe('3000.00');
    expect(checkInvariants(st)).toEqual([]);
    g(st, d.id).approval!.amount = '1.00';
    expect(checkInvariants(st).join('\n')).toContain(`${d.id}: EX total 3000.00 needs approval but the approval covers only 1.00`);
  });

  it('a correction plan that raises the money for a role without the approve right is refused when built', () => {
    const st = buildSeedState();
    const d = exDraft(st, '1000.00');
    approveAndIssue(st, d.id, d.version, me);
    const x = g(st, d.id);
    expect(err(() => buildPlan(st, x.id, { header: x.header, lines: [L('a', 'EX', '3000.00')] }, 'operator')).code).toBe('approval.required_on_revise');
  });

  it('M1: reissue judges the NEW total', () => {
    const st = buildSeedState();
    const line = (price: string) => ({ header: { partyId: 'pv-03', documentDate: '2026-10-14' }, lines: [L('t', 'EX', price, { expenseCategory: 'transport' })] });
    const big = createDraft(st, 'co-vat', 'PV', line('60000.00'), me, k());
    approveAndIssue(st, big.id, big.version, me);
    const down = reissue(st, big.id, line('1000.00'), me, 'lower');
    expect(down.totals.total).toBe('1000.00');
    const small = createDraft(st, 'co-vat', 'PV', line('1000.00'), me, k());
    issue(st, small.id, small.version, me);
    expect(err(() => reissue(st, small.id, line('60000.00'), me, 'higher')).code).toBe('approval.required');
    expect(checkInvariants(st)).toEqual([]);
  });
});

describe('I1: a voucher to an employee only pays claims', () => {
  const emp = (lines: DocLine[], allocations?: { targetId: string; targetType: 'EX'; amount: string }[]) => ({ header: { partyId: 'emp-01', documentDate: '2026-10-14' }, lines, ...(allocations ? { allocations } : {}) });
  it('G: lines only, no claim behind it, is refused with its exit', () => {
    const st = buildSeedState();
    const d = createDraft(st, 'co-vat', 'PV', emp([L('t', 'EX', '40000.00', { expenseCategory: 'transport' })]), me, k());
    const e = err(() => issue(st, d.id, d.version, me));
    expect([e.status, e.code]).toEqual([422, 'pv.employee_claims_only']);
    expect(e.title).toContain('บันทึกเป็นใบเบิกค่าใช้จ่ายแล้วจ่ายจากใบเบิก');
  });
  it('D: own lines next to a claim allocation (WHT on an employee) is refused', () => {
    const st = buildSeedState();
    const e = createDraft(st, 'co-vat', 'EX', { header: { partyId: 'emp-01', documentDate: '2026-10-14' }, lines: [L('a', 'EX', '3000.00')] }, me, k());
    approveAndIssue(st, e.id, e.version, me);
    const w = createDraft(st, 'co-vat', 'PV', emp([L('s', 'EX', '5000.00', { expenseCategory: 'services', whtTypeCode: 'SVC' })], [{ targetId: e.id, targetType: 'EX', amount: '3000.00' }]), me, k());
    expect(err(() => issue(st, w.id, w.version, me)).code).toBe('pv.employee_claims_only');
  });
  it('the voucher that converts from a claim still issues', () => {
    const st = buildSeedState();
    const e = exDraft(st, '3000.00', me, 'emp-01');
    approveAndIssue(st, e.id, e.version, me);
    const pv = convert(st, e.id, 'PV', [], me);
    expect(issue(st, pv.id, pv.version, me).status).toBe('issued');
    expect(checkInvariants(st)).toEqual([]);
  });
});

describe('I2: with self-approval off, neither the creator nor the one who set the money approves', () => {
  it('E: u-2 creates, u-1 edits the money, u-1 cannot approve-and-issue it', () => {
    const st = buildSeedState();
    noSelf(st);
    const d = exDraft(st, '100.00', other);
    const u = updateDraft(st, d.id, { header: g(st, d.id).header, lines: [L('a', 'EX', '90000.00')] }, d.version, me);
    expect(err(() => approveAndIssue(st, u.id, u.version, me)).code).toBe('approval.self_not_allowed');
    expect(g(st, d.id).status).toBe('draft');
  });
  it('a note-only edit (no money) does not make the editor a money setter', () => {
    const st = buildSeedState();
    noSelf(st);
    const d = exDraft(st, '100.00', other);
    const h = g(st, d.id).header;
    const u = updateDraft(st, d.id, { header: { ...h, notes: 'n' }, lines: g(st, d.id).lines }, d.version, me);
    expect(approveAndIssue(st, u.id, u.version, me).status).toBe('issued');
  });
  it('the one who submitted cannot approve; another approver can', () => {
    const st = buildSeedState();
    noSelf(st);
    const d = exDraft(st, '100.00', other);
    const s = submitForApproval(st, d.id, d.version, me);
    expect(err(() => approve(st, s.id, s.version, me)).code).toBe('approval.self_not_allowed');
    expect(approve(st, s.id, s.version, { ...me, id: 'u-3', name: 'Third' }).status).toBe('approved');
  });
  it('a revise that needs approval cannot be approved by the person making it', () => {
    const st = buildSeedState();
    const d = exDraft(st, '1000.00', other);
    approveAndIssue(st, d.id, d.version, me);
    noSelf(st);
    const x = g(st, d.id);
    expect(err(() => revise(st, x.id, { header: x.header, lines: [L('a', 'EX', '5000.00')] }, x.version, 'r', me, { approver: me })).code).toBe('approval.self_not_allowed');
  });
});

describe('M2: only a full tax invoice in the company name is claimable', () => {
  const claim = (fullTaxInvoice: boolean | undefined) => {
    const st = buildSeedState();
    const d = createDraft(st, 'co-vat', 'EX', { header: { partyId: 'emp-02', documentDate: '2026-10-14' }, lines: [L('a', 'S7', '1000.00', { vendorInvoice: { vendorName: 'v', vendorTin: TIN, number: '1', date: '2026-10-12', ...(fullTaxInvoice === undefined ? {} : { fullTaxInvoice }) } })] }, me, k());
    approveAndIssue(st, d.id, d.version, me);
    const lines = st.journals.find((j) => j.docId === d.id)!.preview.entries[0].lines;
    const sum = (code: string) => lines.filter((l) => l.accountCode === code).reduce((a, l) => a + Number(l.debit), 0);
    return { c1170: sum('1170'), c5170: sum('5170'), inv: checkInvariants(st) };
  };
  it('true claims 1170; false or absent is cost (5170)', () => {
    expect(claim(true)).toEqual({ c1170: 70, c5170: 0, inv: [] });
    expect(claim(false)).toEqual({ c1170: 0, c5170: 70, inv: [] });
    expect(claim(undefined)).toEqual({ c1170: 0, c5170: 70, inv: [] });
  });
});

describe('M3: every refusal on a pending / approved claim names its exit', () => {
  it('delete and cancel of a pending claim point to the approver sending it back', () => {
    const st = buildSeedState();
    const d = exDraft(st, '100.00');
    const s = submitForApproval(st, d.id, d.version, me);
    expect(err(() => deleteDraft(st, s.id, s.version, me)).title).toContain('ให้ผู้อนุมัติส่งกลับแก้ไขก่อน');
    expect(err(() => cancel(st, s.id, s.version, 'OTHER', 'x', me)).title).toContain('ให้ผู้อนุมัติส่งกลับแก้ไขก่อน');
    const a = approve(st, s.id, s.version, me);
    expect(err(() => deleteDraft(st, a.id, a.version, me)).title).toContain('ให้ผู้อนุมัติส่งกลับแก้ไขก่อน');
  });
});
