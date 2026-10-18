import type { Actor, Allocation, ApprovalPolicy, Doc, DocType, Money } from '@/domain/types';
import type { MockState } from '../store';
import { refuseAgent } from './company';
import { MockError, logActivity, logAudit, stamp } from './log';
import { fromSatang, toSatang } from './money';
import { payoutOf } from './settlement';

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

/** ST3 (P4 m3): the policy that applied to a document when it was submitted / issued, frozen on it: a later policy change never changes the approval state of a document already submitted, pending or issued. */
export interface ApprovalSnapshot { enabled: boolean; minAmount?: Money; selfApproval: boolean }
const snapOf = (p?: ApprovalPolicy): ApprovalSnapshot => ({ enabled: !!p?.enabled, ...(p?.minAmount ? { minAmount: p.minAmount } : {}), selfApproval: p?.selfApproval ?? true });
export const policySnapshot = (st: MockState, companyId: string, type: DocType): ApprovalSnapshot => snapOf(policyOf(st, companyId, type));
const wants = (p: ApprovalSnapshot, total: Money) => p.enabled && (!p.minAmount || toSatang(total) > toSatang(p.minAmount));

/** §7.6: does the LIVE policy want a document of this type approved before it is issued? `minAmount` is a floor the total must be ABOVE ("PV above 50,000.00"); a type with no rule needs nothing. Drafts are judged by it. */
export function approvalRequired(st: MockState, companyId: string, type: DocType, total: Money): boolean {
  return wants(policySnapshot(st, companyId, type), total);
}
/** The same question for a stored document: a submitted / pending / approved / issued one is judged by the policy frozen on it, a draft (or an engine-made document) by the live one. */
export const approvalRequiredOf = (st: MockState, d: Stored, total: Money): boolean => wants(d.policy ?? policySnapshot(st, d.companyId, d.type), total);

/** C1: does saving this revise of an issued document need an approver? `newPayout` = what the company would then pay out (settled total + the WHT it bears, P4 m1).
 *  Needed when that is above both the old payout and what was approved (0.00 when nothing was) and the policy wants approval at that figure, or - for an approved document - when the documents it pays
 *  (allocation targets) change at all (m2: the approver approved paying THOSE bills). A lower figure on the same targets, or the same money, is free. */
export function reviseNeedsApproval(st: MockState, d: Stored, newPayout: Money, newAllocations?: Allocation[]): boolean {
  if (!approvalRequiredOf(st, d, newPayout)) return false;
  const covered = d.approval?.approvedBy ? toSatang(d.approval.amount ?? '0.00') : 0;
  const targets = (a?: Allocation[]) => (a ?? []).map((x) => x.targetId).sort().join('|');
  return (toSatang(newPayout) > toSatang(payoutOf(st, d.companyId, d)) && toSatang(newPayout) > covered) || (!!d.approval?.approvedBy && targets(newAllocations) !== targets(d.allocations));
}

/** Self-approval off: neither the creator, nor whoever last changed the money (I2), nor whoever sent it for approval can approve it. */
export function refuseSelfApproval(st: MockState, d: Stored, actor: Actor): void {
  if ((d.policy ?? policySnapshot(st, d.companyId, d.type)).selfApproval === false && [d.createdBy.id, d.moneyBy?.id, d.approval?.submittedBy.id].includes(actor.id)) {
    throw new MockError(403, 'approval.self_not_allowed', 'ผู้จัดทำ ผู้แก้ไขยอด หรือผู้ส่งอนุมัติ อนุมัติเอกสารของตัวเองไม่ได้ (นโยบายการอนุมัติปิดการอนุมัติด้วยตนเอง) ให้ผู้มีสิทธิ์อนุมัติคนอื่นอนุมัติ');
  }
}

/** The guard on issue (§7.6): a document the policy wants approved issues only from `approved` (or through approve-and-issue). Every refusal names its exit. */
export function refuseUnapprovedIssue(st: MockState, d: Stored): void {
  if (d.status === 'pending') throw new MockError(409, 'approval.pending', 'เอกสารนี้รออนุมัติ ออกเอกสารไม่ได้ ให้ผู้มีสิทธิ์อนุมัติ (หรือกด “อนุมัติและออก”) หรือส่งกลับแก้ไข');
  if (d.status === 'draft' && approvalRequired(st, d.companyId, d.type, payoutOf(st, d.companyId, d))) {
    throw new MockError(422, 'approval.required', 'เอกสารประเภทนี้ต้องได้รับอนุมัติก่อนออกเอกสาร กด “ส่งอนุมัติ” หรือ “อนุมัติและออก” (ถ้าคุณมีสิทธิ์อนุมัติ)');
  }
}

/** draft -> pending. Refused when the policy does not need it (then issue directly). */
export function submit(st: MockState, id: string, version: number, actor: Actor): Doc {
  const d = find(st, id);
  if (d.status !== 'draft') throw new MockError(409, 'doc.not_draft', 'ส่งอนุมัติได้เฉพาะเอกสารฉบับร่าง');
  checkVersion(d, version);
  if (!approvalRequired(st, d.companyId, d.type, payoutOf(st, d.companyId, d))) {
    throw new MockError(422, 'approval.not_required', 'เอกสารนี้ไม่ต้องส่งอนุมัติ (นโยบายปิดอยู่ หรือยอดไม่เกินวงเงินที่ต้องอนุมัติ) ออกเอกสารได้เลย');
  }
  const next: Stored = { ...d, status: 'pending', approval: { submittedBy: actor, submittedAt: stamp() }, policy: policySnapshot(st, d.companyId, d.type), version: d.version + 1 };
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
  const next: Stored = { ...d, status: 'approved', approval: { ...d.approval!, approvedBy: actor, approvedAt: stamp(), amount: payoutOf(st, d.companyId, d) }, version: d.version + 1 };
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
  const { approval: _a, policy: _p, ...rest } = d; void _a; void _p; // back to a draft: the live policy applies again, a new submit freezes a new one
  const next: Stored = { ...rest, status: 'draft', version: d.version + 1 };
  put(st, next);
  logActivity(st, id, actor, 'send_back', `ส่งกลับแก้ไข: ${reason.trim()}`);
  logAudit(st, actor, d.companyId, 'doc.send_back', id, { status: d.status }, { status: 'draft', reason: reason.trim() });
  return strip(next);
}

const conflict = () => new MockError(409, 'record.version_conflict', 'การตั้งค่าการอนุมัติถูกแก้ไขโดยผู้อื่นแล้ว โหลดข้อมูลใหม่ก่อนบันทึก');
const amount = (v: unknown, label: string): Money => {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!/^\d{1,12}(\.\d{1,2})?$/.test(s)) throw new MockError(422, 'approval.invalid_amount', label + ' ต้องเป็นจำนวนเงินตั้งแต่ 0.00 (ทศนิยมไม่เกิน 2 ตำแหน่ง)');
  return fromSatang(toSatang(s));
};
const rulesOf = (st: MockState, companyId: string) => st.approvalPolicies.filter((p) => p.companyId === companyId);
const groupVersion = (st: MockState, companyId: string) => Math.max(1, ...rulesOf(st, companyId).map((p) => p.version ?? 1));

export interface ApprovalsView {
  items: { docType: DocType; enabled: boolean; minAmount?: Money; version: number }[];
  /** Company-wide: true when every rule lets the creator approve their own document. */ selfApproval: boolean; selfApprovalVersion: number;
  /** FN3: the largest difference a settlement may absorb (satang rounding; a small write-off, also the bank fee). */ tolerance: { rounding: Money; smallWriteOff: Money; version: number };
}
export function approvalsView(st: MockState, companyId: string): ApprovalsView {
  const rules = rulesOf(st, companyId), t = st.settlementTolerance.find((x) => x.companyId === companyId);
  return {
    items: rules.map((p) => ({ docType: p.docType, enabled: p.enabled, ...(p.minAmount ? { minAmount: p.minAmount } : {}), version: p.version ?? 1 })).sort((a, b) => a.docType.localeCompare(b.docType)),
    selfApproval: rules.every((p) => p.selfApproval), selfApprovalVersion: groupVersion(st, companyId),
    tolerance: { rounding: t?.rounding ?? '0.00', smallWriteOff: t?.smallWriteOff ?? '0.00', version: t?.version ?? 1 },
  };
}

export function updateApprovalRule(st: MockState, actor: Actor, companyId: string, type: string, b: Record<string, unknown>): ApprovalsView['items'][number] {
  refuseAgent(actor);
  const p = rulesOf(st, companyId).find((x) => x.docType === type);
  if (!p) throw new MockError(404, 'approval.not_found', 'ไม่พบกฎการอนุมัติของเอกสารประเภทนี้');
  if (b.version !== (p.version ?? 1)) throw conflict();
  if (typeof b.enabled !== 'boolean') throw new MockError(422, 'record.invalid', 'ต้องระบุว่าเปิดหรือปิดการอนุมัติ');
  const before = { enabled: p.enabled, minAmount: p.minAmount }, min = typeof b.minAmount === 'string' && b.minAmount.trim() ? amount(b.minAmount, 'วงเงินขั้นต่ำที่ต้องอนุมัติ') : undefined;
  p.enabled = b.enabled; p.version = (p.version ?? 1) + 1;
  if (min && toSatang(min) > 0) p.minAmount = min; else delete p.minAmount; // one threshold per type (O-5); 0.00 = every document
  logAudit(st, actor, companyId, 'approval.rule.update', type, before, { enabled: p.enabled, minAmount: p.minAmount });
  return approvalsView(st, companyId).items.find((x) => x.docType === type)!;
}

export function setSelfApproval(st: MockState, actor: Actor, companyId: string, b: Record<string, unknown>): ApprovalsView {
  refuseAgent(actor);
  if (b.version !== groupVersion(st, companyId)) throw conflict();
  if (typeof b.selfApproval !== 'boolean') throw new MockError(422, 'record.invalid', 'ต้องระบุว่าอนุญาตให้อนุมัติเอกสารของตัวเองหรือไม่');
  const before = approvalsView(st, companyId).selfApproval, v = groupVersion(st, companyId) + 1;
  for (const p of rulesOf(st, companyId)) { p.selfApproval = b.selfApproval; p.version = v; }
  logAudit(st, actor, companyId, 'approval.self.update', undefined, { selfApproval: before }, { selfApproval: b.selfApproval });
  return approvalsView(st, companyId);
}

export function setTolerance(st: MockState, actor: Actor, companyId: string, b: Record<string, unknown>): ApprovalsView['tolerance'] {
  refuseAgent(actor);
  const t = st.settlementTolerance.find((x) => x.companyId === companyId);
  if (!t) throw new MockError(404, 'company.not_found', 'ไม่พบบริษัท');
  if (b.version !== (t.version ?? 1)) throw conflict();
  const rounding = amount(b.rounding, 'เกณฑ์ปัดเศษ'), smallWriteOff = amount(b.smallWriteOff, 'เกณฑ์ตัดส่วนต่างเล็กน้อย');
  const before = { rounding: t.rounding, smallWriteOff: t.smallWriteOff };
  Object.assign(t, { rounding, smallWriteOff, version: (t.version ?? 1) + 1 });
  logAudit(st, actor, companyId, 'settlement.tolerance.update', undefined, before, { rounding, smallWriteOff });
  return approvalsView(st, companyId).tolerance;
}
