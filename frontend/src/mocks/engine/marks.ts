import { CLOSEABLE, LIVE, MARKS } from '@/domain/doc-types';
import type { Actor, Doc, DocMarks, MarkKey, RemainingLine } from '@/domain/types';
import type { MockState } from '../store';
import { consumed, fmtQ, q4 } from './chain';
import { MockError, logActivity, logAudit, stamp } from './log';

// No import from commands.ts: commands (convert / revise) import this file.
type Stored = MockState['docs'][number];
const find = (st: MockState, id: string): Stored => {
  const d = st.docs.find((x) => x.id === id);
  if (!d) throw new MockError(404, 'doc.not_found', 'ไม่พบเอกสาร');
  return d;
};
const strip = ({ companyId, ...r }: Stored): Doc => (void companyId, structuredClone(r));

export const REJECTED_QT_TH = 'ใบเสนอราคานี้ถูกปฏิเสธแล้ว — แก้ไขเป็นฉบับใหม่หรือคัดลอกเป็นใบใหม่';
/** convert(): a rejected quotation is not converted until it is revised or copied. */
export const refuseRejected = (d: Stored): void => {
  if (d.type === 'QT' && d.marks?.rejected) throw new MockError(409, 'qt.rejected', REJECTED_QT_TH);
};
export const CLOSED_TH = 'เอกสารนี้ปิดยอดคงเหลือแล้ว แปลงต่อไม่ได้ ให้แก้ไขเอกสาร (ฉบับแก้ไข) เพื่อเปิดยอดคงเหลือใหม่ก่อน';
/** convert(): a document whose remainder was closed converts nothing more until it is revised. */
export const refuseClosed = (d: Stored): void => {
  if (d.marks?.closed) throw new MockError(409, 'doc.closed', CLOSED_TH);
};
/** convert(): converting a quotation is the customer's acceptance, stamped once. */
export const withAcceptedStamp = (d: Stored, actor: Actor): DocMarks | undefined =>
  d.type === 'QT' && !d.marks?.accepted ? { ...d.marks, accepted: { at: stamp(), by: actor.name } } : d.marks;
/** revise(): an N-class revision of a quotation is a new offer, the customer's answer to the old one is void. */
export const afterRevision = (d: Stored): DocMarks | undefined => {
  if (!d.marks) return d.marks;
  const { accepted, rejected, closed, ...rest } = d.marks; void closed; // an N-class revision reopens a closed remainder (the exit)
  const kept: DocMarks = d.type === 'QT' ? rest : { ...rest, ...(accepted ? { accepted } : {}), ...(rejected ? { rejected } : {}) };
  return Object.keys(kept).length ? kept : undefined;
};

/** Closes what is left to convert on a live SO / DO / PO. A mark: no revision, no totals change; an N-class revision reopens it.
 *  A draft target that already reserved quantity stays valid (it was within the remainder when created): issuing it after the close works, /remaining stays 0. */
export function closeRemainder(st: MockState, id: string, version: number, reason: string, actor: Actor): Doc {
  const d = find(st, id);
  if (!CLOSEABLE.includes(d.type)) throw new MockError(422, 'mark.not_allowed', 'เอกสารประเภทนี้ปิดยอดคงเหลือไม่ได้');
  if (!LIVE.includes(d.status)) throw new MockError(409, 'doc.not_live', 'ปิดยอดคงเหลือได้เฉพาะเอกสารที่ออกแล้วและยังไม่ถูกยกเลิก');
  if (d.version !== version) throw new MockError(409, 'doc.version_conflict', 'เอกสารถูกแก้ไขโดยผู้อื่นแล้ว กรุณาโหลดใหม่');
  const why = reason?.trim();
  if (!why) throw new MockError(422, 'mark.reason_required', 'ต้องระบุเหตุผลที่ปิดยอดคงเหลือ');
  if (d.marks?.closed) throw new MockError(409, 'doc.already_closed', 'เอกสารนี้ปิดยอดคงเหลือแล้ว');
  if (remainingOf(st, id).every((l) => l.remaining === '0')) throw new MockError(409, 'doc.nothing_remaining', 'ไม่มียอดคงเหลือให้ปิด (แปลงครบทุกรายการแล้ว)');
  const marks: DocMarks = { ...d.marks, closed: { at: stamp(), by: actor.name, reason: why } };
  const next: Stored = { ...d, marks, version: d.version + 1 };
  st.docs[st.docs.findIndex((x) => x.id === id)] = next;
  logActivity(st, id, actor, 'close', why);
  logAudit(st, actor, d.companyId, 'doc.mark', id, { marks: d.marks }, { marks });
  return strip(next);
}

const ACTION: Record<MarkKey, string> = { accepted: 'accept', rejected: 'reject', delivered: 'deliver', sent: 'send' };

/** Sets a mark on a live document. No revision, no change to totals; logged in activity and audit. */
export function setMark(st: MockState, id: string, mark: MarkKey, version: number, actor: Actor, reason?: string): Doc {
  const d = find(st, id);
  if (!MARKS[d.type]?.includes(mark)) throw new MockError(422, 'mark.not_allowed', `เอกสารประเภทนี้ใช้เครื่องหมาย “${mark}” ไม่ได้`);
  if (!LIVE.includes(d.status)) throw new MockError(409, 'doc.not_live', 'ทำเครื่องหมายได้เฉพาะเอกสารที่ออกแล้วและยังไม่ถูกยกเลิก');
  if (d.version !== version) throw new MockError(409, 'doc.version_conflict', 'เอกสารถูกแก้ไขโดยผู้อื่นแล้ว กรุณาโหลดใหม่');
  const why = reason?.trim();
  if (mark === 'rejected' && !why) throw new MockError(422, 'mark.reason_required', 'ต้องระบุเหตุผลที่ลูกค้าปฏิเสธ');
  const at = stamp(), by = actor.name;
  const { accepted, rejected, ...others } = d.marks ?? {}; void accepted; void rejected; // the customer's answer is one or the other
  const keep = mark === 'accepted' || mark === 'rejected' ? others : d.marks;
  const marks: DocMarks = { ...keep, [mark]: mark === 'rejected' ? { at, by, reason: why! } : { at, by } };
  const next: Stored = { ...d, marks, version: d.version + 1 };
  st.docs[st.docs.findIndex((x) => x.id === id)] = next;
  logActivity(st, id, actor, ACTION[mark], mark === 'rejected' ? why : undefined);
  logAudit(st, actor, d.companyId, 'doc.mark', id, { marks: d.marks }, { marks });
  return strip(next);
}

/** What is left of each line of a convertible document (drafts of the target reserve their quantity, as in convert()). */
export function remainingOf(st: MockState, id: string): RemainingLine[] {
  const d = find(st, id);
  return d.lines.map((l) => {
    const ordered = q4(l.qty), converted = consumed(st, d, l);
    return { lineId: l.id, description: l.description, unit: l.unit, ordered: fmtQ(ordered), converted: fmtQ(converted),
      remaining: d.marks?.closed ? '0' : fmtQ(Math.max(0, ordered - converted)), closed: !!d.marks?.closed };
  });
}
