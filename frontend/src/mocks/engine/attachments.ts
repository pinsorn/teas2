import type { Actor, Attachment, AttachmentCategory, Doc } from '@/domain/types';
import type { MockState } from '../store';
import { MockError, logActivity, logAudit, stamp } from './log';

/** D-30 (open item O-6: the list is TEAS 1's, not re-verified). */
export const ATTACHMENT_CATEGORIES: AttachmentCategory[] = ['customer_po', 'purchase_order', 'delivery', 'vendor_tax_invoice', 'receipt', 'transfer_slip',
  'contract', 'photo', 'wht_certificate', 'government', 'other'];
export const MAX_ATTACHMENT_BYTES = 1024 * 1024;
export const ATTACHMENT_MIMES = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'];

const PREFIX = 'teas2.mock.att.';
const keyOf = (id: string) => `${PREFIX}${id}`;
const readBlob = (id: string): string => { try { return localStorage.getItem(keyOf(id)) ?? ''; } catch { return ''; } };
const dropBlob = (id: string) => { try { localStorage.removeItem(keyOf(id)); } catch { /* nothing to drop */ } };

/** "รีเซ็ตข้อมูลตัวอย่าง": every stored file goes with the state. */
export function clearAttachmentBlobs(): void {
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith(PREFIX)) localStorage.removeItem(k);
  } catch { /* storage unavailable: nothing was stored */ }
}

/** The facts a data URL states about itself, so the server never trusts the client's size / type. */
function parse(dataUrl: unknown): { mime: string; bytes: number } | undefined {
  const m = typeof dataUrl === 'string' ? /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/.exec(dataUrl) : null;
  if (!m) return undefined;
  const b64 = m[2];
  return { mime: m[1], bytes: Math.floor((b64.length * 3) / 4) - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0) };
}

type Meta = MockState['attachments'][number];
const publicMeta = ({ companyId, ...a }: Meta): Omit<Attachment, 'dataUrl'> => { void companyId; return a; };

export function listAttachments(st: MockState, docId: string): Attachment[] {
  return st.attachments.filter((a) => a.docId === docId).sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))
    .map((a) => ({ ...publicMeta(a), dataUrl: readBlob(a.id) }));
}

/** Validates, writes the bytes to their own key FIRST (a refused write is a 507, never silently lost), then records the metadata. */
export function addAttachment(st: MockState, doc: Doc & { companyId: string }, input: { category: AttachmentCategory; name: string; mime: string; dataUrl: string }, actor: Actor): Attachment {
  if (!ATTACHMENT_CATEGORIES.includes(input.category)) throw new MockError(422, 'attachment.category_invalid', 'ประเภทไฟล์แนบไม่ถูกต้อง');
  if (!input.name?.trim()) throw new MockError(422, 'attachment.name_required', 'ต้องระบุชื่อไฟล์');
  const info = parse(input.dataUrl);
  if (!info || !ATTACHMENT_MIMES.includes(info.mime) || info.mime !== input.mime) {
    throw new MockError(422, 'attachment.type_not_allowed', 'แนบได้เฉพาะไฟล์ PDF, PNG, JPEG หรือ WebP');
  }
  if (info.bytes > MAX_ATTACHMENT_BYTES) throw new MockError(422, 'attachment.too_large', 'ไฟล์ใหญ่เกิน 1 MB');
  const id = `att-${crypto.randomUUID()}`;
  try { localStorage.setItem(keyOf(id), input.dataUrl); } catch {
    throw new MockError(507, 'attachment.storage_full', 'พื้นที่เก็บไฟล์ตัวอย่างเต็ม — ลบไฟล์แนบเก่าหรือรีเซ็ตข้อมูลตัวอย่าง');
  }
  const meta: Meta = { companyId: doc.companyId, id, docId: doc.id, category: input.category, name: input.name.trim(), size: info.bytes, mime: info.mime, at: stamp(), by: actor.name };
  st.attachments.push(meta);
  if (doc.status !== 'draft') logActivity(st, doc.id, actor, 'แนบไฟล์', meta.name);
  return { ...publicMeta(meta), dataUrl: input.dataUrl };
}

/** Undoes `addAttachment` when the metadata could not be persisted either. */
export function discardAttachment(st: MockState, id: string): void {
  st.attachments = st.attachments.filter((a) => a.id !== id);
  dropBlob(id);
}

/** A draft's file just goes; on an issued document the removal is audited and shows on the timeline. */
export function removeAttachment(st: MockState, doc: Doc & { companyId: string }, attId: string, actor: Actor): void {
  const a = st.attachments.find((x) => x.id === attId && x.docId === doc.id);
  if (!a) throw new MockError(404, 'attachment.not_found', 'ไม่พบไฟล์แนบ');
  st.attachments = st.attachments.filter((x) => x.id !== attId);
  dropBlob(attId);
  if (doc.status !== 'draft') {
    logAudit(st, actor, doc.companyId, 'attachment.remove', doc.id, { name: a.name, category: a.category });
    logActivity(st, doc.id, actor, 'ลบไฟล์แนบ', a.name);
  }
}

/** A draft that is deleted takes its files with it. */
export function dropAttachmentsOf(st: MockState, docId: string): void {
  for (const a of st.attachments.filter((x) => x.docId === docId)) dropBlob(a.id);
  st.attachments = st.attachments.filter((x) => x.docId !== docId);
}

export const printCountOf = (st: MockState, docId: string): number => st.prints.filter((p) => p.docId === docId).length;

/** The print action was used. The server decides what it was: the first print of a live document is the ต้นฉบับ, every later one a สำเนา whatever the caller asked.
 *  A cancelled / replaced document may be printed (the paper carries its void stamp) but that is logged as such and is never the original. */
export function markPrinted(st: MockState, doc: Doc, copy: boolean, actor: Actor): { copy: boolean; printCount: number } {
  if (['draft', 'pending', 'approved'].includes(doc.status)) throw new MockError(409, 'doc.not_printable', 'เอกสารที่ยังไม่ได้ออกพิมพ์ไม่ได้ ต้องออกเอกสารก่อน');
  const dead = doc.status === 'cancelled' || doc.status === 'replaced';
  const asCopy = copy || dead || printCountOf(st, doc.id) > 0;
  st.prints.push({ docId: doc.id, at: stamp(), by: actor.name, copy: asCopy });
  logActivity(st, doc.id, actor, dead ? 'พิมพ์เอกสารที่ยกเลิกแล้ว' : asCopy ? 'พิมพ์สำเนา' : 'พิมพ์ต้นฉบับ');
  return { copy: asCopy, printCount: printCountOf(st, doc.id) };
}
