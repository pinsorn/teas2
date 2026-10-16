import { describe, expect, it } from 'vitest';
import type { Actor, DocLine, DocType } from '@/domain/types';
import { USER as me } from '../fixtures/documents';
import { fixtureIds } from '../fixtures/ids';
import { buildSeedState, type MockState } from '../store';
import { approve, approvalRequired, sendBack, submit } from './approval';
import { approveAndIssue, createDraft, issue, reissue, updateDraft } from './commands';
import { checkInvariants } from './invariants';
import { MockError } from './log';

/** §7.6: approval is a server-side gate on issue. Every scenario drives the real commands; a refusal names its code. */
const other: Actor = { kind: 'user', id: 'u-2', name: 'ผู้อนุมัติ ตัวอย่าง' };
const L = (id: string, price: string, p: Partial<DocLine> = {}): DocLine => ({ id, description: `ค่าใช้จ่าย ${id}`, qty: '1', unit: 'ครั้ง', unitPrice: price, taxCode: 'EX', expenseCategory: 'transport', ...p });
const get = (st: MockState, id: string) => st.docs.find((d) => d.id === id)!;
let n = 0;
const ex = (st: MockState, price = '350.00', party = 'emp-02') => createDraft(st, 'co-vat', 'EX', { header: { partyId: party, documentDate: '2026-10-14' }, lines: [L(`e${n}`, price)] }, me, `ap${n++}`);
const pvDraft = (st: MockState, price: string) => createDraft(st, 'co-vat', 'PV', { header: { partyId: 'pv-01', documentDate: '2026-10-14' }, lines: [L(`v${n}`, price)] }, me, `ap${n++}`);
const code = (f: () => unknown): string | undefined => { try { f(); } catch (e) { return e instanceof MockError ? e.code : String(e); } return undefined; };
const actions = (st: MockState, id: string) => st.activity.filter((a) => a.docId === id).map((a) => a.action);
const setPolicy = (st: MockState, t: DocType, p: Partial<MockState['approvalPolicies'][number]>, company = 'co-vat') => { Object.assign(st.approvalPolicies.find((x) => x.companyId === company && x.docType === t)!, p); };

describe('the policy decides, on the computed total', () => {
  it('EX of the VAT company always needs approval, PV only above 50,000.00, the non-VAT company never', () => {
    const st = buildSeedState();
    expect(approvalRequired(st, 'co-vat', 'EX', '0.01')).toBe(true);
    expect(approvalRequired(st, 'co-vat', 'PV', '50000.00')).toBe(false);
    expect(approvalRequired(st, 'co-vat', 'PV', '50000.01')).toBe(true);
    expect(approvalRequired(st, 'co-nonvat', 'EX', '9999999.00')).toBe(false);
    expect(approvalRequired(st, 'co-vat', 'PB', '9999999.00')).toBe(false); // PB has no policy: QuickBill and every PB path are unaffected
  });
});

describe('issue is gated', () => {
  it('a direct issue of an approval-enabled EX is refused with its exit; the draft is untouched', () => {
    const st = buildSeedState();
    const d = ex(st);
    expect(code(() => issue(st, d.id, d.version, me))).toBe('approval.required');
    expect(get(st, d.id)).toMatchObject({ status: 'draft', version: d.version });
    expect(get(st, d.id).number).toBeUndefined();
    expect(checkInvariants(st)).toEqual([]);
  });
  it('a PV above 50,000.00 is refused, at 50,000.00 it issues directly', () => {
    const st = buildSeedState();
    const big = pvDraft(st, '50000.01'), edge = pvDraft(st, '50000.00');
    expect(code(() => issue(st, big.id, big.version, me))).toBe('approval.required');
    expect(code(() => issue(st, edge.id, edge.version, me))).toBeUndefined();
    expect(get(st, edge.id).status).toBe('issued');
  });
  it('the non-VAT company issues an EX directly', () => {
    const st = buildSeedState();
    const d = createDraft(st, 'co-nonvat', 'EX', { header: { partyId: 'nemp-01', documentDate: '2026-10-14' }, lines: [L('n1', '120.00')] }, me, 'ap-nv');
    expect(code(() => issue(st, d.id, d.version, me))).toBeUndefined();
    expect(get(st, d.id).status).toBe('issued');
  });
});

describe('submit / approve / issue', () => {
  it('draft -> pending -> approved -> issued; the number is allocated once, at issue, and the trail names both people', () => {
    const st = buildSeedState();
    const d = ex(st);
    submit(st, d.id, d.version, me);
    expect(get(st, d.id)).toMatchObject({ status: 'pending', approval: { submittedBy: { id: 'u-1' } } });
    expect(get(st, d.id).number).toBeUndefined();
    const p = get(st, d.id);
    expect(code(() => issue(st, p.id, p.version, me))).toBe('approval.pending'); // the exit (approve / send back) is in its message
    expect(code(() => updateDraft(st, p.id, { header: p.header, lines: p.lines }, p.version, me))).toBe('approval.pending');
    approve(st, p.id, p.version, other);
    const a = get(st, d.id);
    expect(a).toMatchObject({ status: 'approved', approval: { approvedBy: { id: 'u-2' } } });
    expect(a.number).toBeUndefined();
    issue(st, a.id, a.version, other);
    const i = get(st, d.id);
    expect(i.status).toBe('issued');
    expect(i.number).toMatch(/^EX-\d{6}-\d{4}$/);
    expect(i.approval?.approvedBy?.id).toBe('u-2');
    expect(actions(st, d.id)).toEqual(['create', 'submit', 'approve', 'issue']);
    expect(checkInvariants(st)).toEqual([]);
  });
  it('submit is refused when the policy is off or the total is not above the minimum: issue directly', () => {
    const st = buildSeedState();
    const small = pvDraft(st, '1000.00');
    expect(code(() => submit(st, small.id, small.version, me))).toBe('approval.not_required');
    const nv = createDraft(st, 'co-nonvat', 'EX', { header: { partyId: 'nemp-01', documentDate: '2026-10-14' }, lines: [L('n2', '120.00')] }, me, 'ap-nv2');
    expect(code(() => submit(st, nv.id, nv.version, me))).toBe('approval.not_required');
  });
  it('approve needs a pending document; submit needs a draft', () => {
    const st = buildSeedState();
    const d = ex(st);
    expect(code(() => approve(st, d.id, d.version, other))).toBe('approval.not_pending');
    submit(st, d.id, d.version, me);
    const p = get(st, d.id);
    expect(code(() => submit(st, p.id, p.version, me))).toBe('doc.not_draft');
    expect(code(() => approve(st, p.id, p.version - 1, other))).toBe('doc.version_conflict');
  });
});

describe('self-approval', () => {
  it('off: the creator is refused (approve and approve-and-issue), another person is not', () => {
    const st = buildSeedState();
    setPolicy(st, 'EX', { selfApproval: false });
    const d = ex(st);
    expect(code(() => approveAndIssue(st, d.id, d.version, me))).toBe('approval.self_not_allowed');
    expect(get(st, d.id).status).toBe('draft');
    submit(st, d.id, d.version, me);
    const p = get(st, d.id);
    expect(code(() => approve(st, p.id, p.version, me))).toBe('approval.self_not_allowed');
    expect(get(st, d.id).status).toBe('pending');
    approve(st, p.id, p.version, other);
    expect(get(st, d.id).status).toBe('approved');
  });
  it('on: the creator approves their own', () => {
    const st = buildSeedState();
    const d = ex(st);
    submit(st, d.id, d.version, me);
    expect(code(() => approve(st, d.id, get(st, d.id).version, me))).toBeUndefined();
  });
});

describe('approve and issue', () => {
  it('one command from a draft: one number, one journal, the activity shows submit + approve + issue', () => {
    const st = buildSeedState();
    const d = ex(st, '1200.00');
    const before = st.series['co-vat|EX|2026-10'] ?? 0;
    approveAndIssue(st, d.id, d.version, other);
    const i = get(st, d.id);
    expect(i.status).toBe('issued');
    expect(st.series['co-vat|EX|2026-10']).toBe(before + 1);
    expect(i.number).toBe(`EX-202610-${String(before + 1).padStart(4, '0')}`);
    expect(st.journals.filter((j) => j.docId === d.id)).toHaveLength(1);
    expect(actions(st, d.id)).toEqual(['create', 'submit', 'approve', 'issue']);
    expect(checkInvariants(st)).toEqual([]);
  });
  it('from a pending document too; a refused one leaves nothing behind (no number, still a draft, no approval record, no activity)', () => {
    const st = buildSeedState();
    const d = ex(st, '500.00');
    submit(st, d.id, d.version, me);
    approveAndIssue(st, d.id, get(st, d.id).version, other);
    expect(get(st, d.id).status).toBe('issued');
    expect(actions(st, d.id)).toEqual(['create', 'submit', 'approve', 'issue']);
    const series = JSON.stringify(st.series);
    const bad = createDraft(st, 'co-vat', 'EX', { header: { partyId: 'emp-02', documentDate: '2026-10-14' }, lines: [] }, me, 'ap-empty');
    expect(code(() => approveAndIssue(st, bad.id, bad.version, other))).toBe('doc.incomplete');
    expect(get(st, bad.id)).toMatchObject({ status: 'draft' });
    expect(get(st, bad.id).approval).toBeUndefined();
    expect(actions(st, bad.id)).toEqual(['create']);
    expect(JSON.stringify(st.series)).toBe(series);
  });
  it('a PB, which has no policy, is not touched: approve-and-issue says nothing is needed', () => {
    const st = buildSeedState();
    const d = createDraft(st, 'co-vat', 'PB', { header: { partyId: 'pv-01', documentDate: '2026-10-14' }, lines: [L('b1', '100.00', { taxCode: 'S7' })] }, me, 'ap-pb');
    expect(code(() => issue(st, d.id, d.version, me))).toBeUndefined();
  });
});

describe('editing and sending back', () => {
  it('editing an approved EX returns it to draft and the approval is gone: it must be sent again', () => {
    const st = buildSeedState();
    const d = ex(st);
    submit(st, d.id, d.version, me);
    approve(st, d.id, get(st, d.id).version, other);
    const a = get(st, d.id);
    updateDraft(st, a.id, { header: a.header, lines: [{ ...a.lines[0], unitPrice: '400.00' }] }, a.version, me);
    const e = get(st, d.id);
    expect(e.status).toBe('draft');
    expect(e.approval).toBeUndefined();
    expect(code(() => issue(st, e.id, e.version, me))).toBe('approval.required');
    expect(actions(st, d.id)).toContain('send_back');
    expect(checkInvariants(st)).toEqual([]);
  });
  it('send back needs a reason; pending and approved go back to draft with "ส่งกลับแก้ไข: <reason>"', () => {
    const st = buildSeedState();
    const d = ex(st);
    expect(code(() => sendBack(st, d.id, d.version, 'x', other))).toBe('approval.not_sendable'); // a draft has nothing to send back
    submit(st, d.id, d.version, me);
    const p = get(st, d.id);
    expect(code(() => sendBack(st, p.id, p.version, '  ', other))).toBe('approval.reason_required');
    sendBack(st, p.id, p.version, 'แนบใบเสร็จไม่ครบ', other);
    expect(get(st, d.id).status).toBe('draft');
    const last = st.activity.filter((a) => a.docId === d.id).at(-1)!;
    expect(last).toMatchObject({ action: 'send_back', detail: 'ส่งกลับแก้ไข: แนบใบเสร็จไม่ครบ' });
    submit(st, d.id, get(st, d.id).version, me);
    approve(st, d.id, get(st, d.id).version, other);
    sendBack(st, d.id, get(st, d.id).version, 'ยอดผิด', other);
    expect(get(st, d.id)).toMatchObject({ status: 'draft' });
    expect(get(st, d.id).approval).toBeUndefined();
  });
});

describe('a reissue is an issue path too', () => {
  it('a tax invoice cannot be reissued while the policy wants TI approved: refused with its exit, nothing replaced', () => {
    const st = buildSeedState();
    st.approvalPolicies.push({ companyId: 'co-vat', docType: 'TI', enabled: true, selfApproval: true });
    const ti = st.docs.find((d) => d.id === fixtureIds(st).tiIssuedUnpaid)!;
    expect(code(() => reissue(st, ti.id, { header: ti.header, lines: ti.lines }, me, 'x'))).toBe('approval.required');
    expect(get(st, ti.id).status).toBe('issued');
  });
});

describe('invariants report a tampered state', () => {
  it('a pending or approved document with a number, a journal or no approval record is reported', () => {
    const st = buildSeedState();
    const d = ex(st);
    submit(st, d.id, d.version, me);
    expect(checkInvariants(st)).toEqual([]);
    Object.assign(get(st, d.id), { number: 'EX-202610-0099' });
    expect(checkInvariants(st).join('\n')).toMatch(/pending.*number|number.*pending/);
    delete get(st, d.id).number;
    delete get(st, d.id).approval;
    expect(checkInvariants(st).join('\n')).toMatch(/approval/);
  });
});
