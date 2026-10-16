import type { Actor, ApprovalPolicy, Doc, DocType, Money } from '@/domain/types';
import type { MockState } from '../store';
import { MockError, logActivity, logAudit, stamp } from './log';
import { toSatang } from './money';

// No import from commands.ts: commands (issue / updateDraft) import this file.
type Stored = MockState['docs'][number];
const find = (st: MockState, id: string): Stored => {
  const d = st.docs.find((x) => x.id === id);
  if (!d) throw new MockError(404, 'doc.not_found', 'ไม่พบเอกสาร');
  return d;
};
const strip = ({ companyId, ...r }: Stored): Doc => (void companyId, structuredClone(r));
const put = (st: MockState, d: Stored) => { st.docs[st.docs.findIndex((x) => x.id === d.id)] = d; };
const checkVersion = (d: Stored, v: number) => {
  if (d.version !== v) throw new MockError(409, 'doc.version_conflict', 'เอกสารถูกแก้ไขโดยผู้อื่นแล้ว กรุณาโหลดใหม่');
};

export const policyOf = (st: MockState, companyId: string, type: DocType): ApprovalPolicy | undefined =>
  st.approvalPolicies.find((p) => p.companyId === companyId && p.docType === type);

/** §7.6: does the policy want this document approved before it is issued? `minAmount` is a floor the total must be ABOVE ("PV above 50,000.00"); a type with no rule needs nothing. */
export function approvalRequired(st: MockState, companyId: string, type: DocType, total: Money): boolean {
  const p = policyOf(st, companyId, type);
  return !!p?.enabled && (!p.minAmount || toSatang(total) > toSatang(p.minAmount));
}

/** Self-approval off: the person who created the document cannot approve it. */
export function refuseSelfApproval(st: MockState, d: Stored, actor: Actor): void {
  if (policyOf(st, d.companyId, d.type)?.selfApproval === false && d.createdBy.id === actor.id) {
    throw new MockError(403, 'approval.self_not_allowed', 'ผู้จัดทำอนุมัติเอกสารของตัวเองไม่ได้ (นโยบายการอนุมัติปิดการอนุมัติด้วยตนเอง) ให้ผู้มีสิทธิ์อนุมัติคนอื่นอนุมัติ');
  }
}

/** The guard on issue (§7.6): a document the policy wants approved issues only from `approved` (or through approve-and-issue). Every refusal names its exit. */
export function refuseUnapprovedIssue(st: MockState, d: Stored): void {
  if (d.status === 'pending') throw new MockError(409, 'approval.pending', 'เอกสารนี้รออนุมัติ ออกเอกสารไม่ได้ ให้ผู้มีสิทธิ์อนุมัติ (หรือกด “อนุมัติและออก”) หรือส่งกลับแก้ไข');
  if (d.status === 'draft' && approvalRequired(st, d.companyId, d.type, d.totals.total)) {
    throw new MockError(422, 'approval.required', 'เอกสารประเภทนี้ต้องได้รับอนุมัติก่อนออกเอกสาร กด “ส่งอนุมัติ” หรือ “อนุมัติและออก” (ถ้าคุณมีสิทธิ์อนุมัติ)');
  }
}

/** draft -> pending. Refused when the policy does not need it (then issue directly). */
export function submit(st: MockState, id: string, version: number, actor: Actor): Doc {
  const d = find(st, id);
  if (d.status !== 'draft') throw new MockError(409, 'doc.not_draft', 'ส่งอนุมัติได้เฉพาะเอกสารฉบับร่าง');
  checkVersion(d, version);
  if (!approvalRequired(st, d.companyId, d.type, d.totals.total)) {
    throw new MockError(422, 'approval.not_required', 'เอกสารนี้ไม่ต้องส่งอนุมัติ (นโยบายปิดอยู่ หรือยอดไม่เกินวงเงินที่ต้องอนุมัติ) ออกเอกสารได้เลย');
  }
  const next: Stored = { ...d, status: 'pending', approval: { submittedBy: actor, submittedAt: stamp() }, version: d.version + 1 };
  put(st, next);
  logActivity(st, id, actor, 'submit');
  logAudit(st, actor, d.companyId, 'doc.submit', id, { status: 'draft' }, { status: 'pending' });
  return strip(next);
}

/** pending -> approved. The number is allocated at issue, not here. */
export function approve(st: MockState, id: string, version: number, actor: Actor): Doc {
  const d = find(st, id);
  if (d.status !== 'pending') throw new MockError(409, 'approval.not_pending', 'อนุมัติได้เฉพาะเอกสารที่รออนุมัติ');
  checkVersion(d, version);
  refuseSelfApproval(st, d, actor);
  const next: Stored = { ...d, status: 'approved', approval: { ...d.approval!, approvedBy: actor, approvedAt: stamp() }, version: d.version + 1 };
  put(st, next);
  logActivity(st, id, actor, 'approve');
  logAudit(st, actor, d.companyId, 'doc.approve', id, { status: 'pending' }, { status: 'approved' });
  return strip(next);
}

/** pending / approved -> draft, with the reason (activity: "ส่งกลับแก้ไข: <reason>"). */
export function sendBack(st: MockState, id: string, version: number, reason: string, actor: Actor): Doc {
  const d = find(st, id);
  if (d.status !== 'pending' && d.status !== 'approved') throw new MockError(409, 'approval.not_sendable', 'ส่งกลับแก้ไขได้เฉพาะเอกสารที่รออนุมัติหรืออนุมัติแล้ว');
  checkVersion(d, version);
  if (!reason.trim()) throw new MockError(422, 'approval.reason_required', 'ต้องระบุเหตุผลที่ส่งกลับแก้ไข');
  const { approval: _a, ...rest } = d; void _a;
  const next: Stored = { ...rest, status: 'draft', version: d.version + 1 };
  put(st, next);
  logActivity(st, id, actor, 'send_back', `ส่งกลับแก้ไข: ${reason.trim()}`);
  logAudit(st, actor, d.companyId, 'doc.send_back', id, { status: d.status }, { status: 'draft', reason: reason.trim() });
  return strip(next);
}
