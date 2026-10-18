import { DOC_TYPES } from '@/domain/doc-types';
import type { Actor, Company, DocType, IssueLook, PaperModel, PaperParty, PrintTemplate } from '@/domain/types';
import type { MockState } from '../store';
import { MockError, logAudit } from './log';

// ST4: what an issued paper shows of the company and of the person who issued it, frozen at issue (I3) - and the print options of each document type.
// This module is a leaf (log.ts imports it for `stampIssue`): it takes nothing from the engine at load time.

type Stored = MockState['docs'][number];

export const branchLabel = (code?: string) => (!code ? undefined : code === '00000' ? 'สำนักงานใหญ่ (00000)' : `สาขา ${code}`);
/** The seller as a paper prints it. */
export const sellerOf = (co: Company): PaperParty => ({ name: co.legalNameTh, nameEn: co.legalNameEn, address: co.address, phone: co.phone, taxId: co.taxId, branchLabel: branchLabel(co.branchCode) });

const fnv = (s: string): number => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h >>> 0; };
/** Content-addressed picture store: a picture is kept once, documents keep only its hash, and an entry is never removed (a replaced logo or a deactivated user keeps their old picture for the papers that used it). */
export function intern(st: MockState, dataUrl: string): string {
  const images = (st.images ??= {});
  let h = `${fnv(dataUrl).toString(16)}-${dataUrl.length.toString(16)}`;
  while (images[h] !== undefined && images[h] !== dataUrl) h += 'x'; // a hash collision never lets one picture stand for another
  images[h] = dataUrl;
  return h;
}

/** The company's logo / stamp and the issuer's signature, position and name as they are NOW, by reference. An agent has no signature (by construction): the issuer is a person. */
export function snapshotLook(st: MockState, companyId: string, actor: Actor): IssueLook {
  const co = st.companies.find((c) => c.id === companyId);
  const me = actor.kind === 'user' ? st.staff.find((m) => m.companyId === companyId && m.userId === actor.id) : undefined;
  return {
    ...(co?.logoDataUrl ? { logo: intern(st, co.logoDataUrl) } : {}), ...(co?.stampDataUrl ? { stamp: intern(st, co.stampDataUrl) } : {}), ...(me?.signatureDataUrl ? { signature: intern(st, me.signatureDataUrl) } : {}),
    issuerName: me?.name ?? actor.name, ...(me?.position ? { issuerPosition: me.position } : {}),
  };
}

/** Issue and every revise / reissue take the seller and the pictures as they are at that moment (a revise re-snapshots). Called from `logActivity` - the one place every issuing path (issue, reissue, system journal vouchers, 50 ทวิ) passes. */
export function stampIssue(st: MockState, doc: Stored, actor: Actor): void {
  const co = st.companies.find((c) => c.id === doc.companyId);
  if (!co || !DOC_TYPES[doc.type]?.printable) return;
  doc.sellerSnapshot = sellerOf(co);
  doc.issueLook = snapshotLook(st, doc.companyId, actor);
}

/** The types that have a printed paper (= PAPER_BUILDERS). */
export const PRINT_TYPES: DocType[] = ['TI', 'QT', 'SO', 'DO', 'IV', 'BL', 'RC', 'CN', 'DN', 'PO', 'PV', 'EX', 'JV', 'WT', 'PR'];
/** The signature role labels a template may use (a fixed list: the union of what the papers print). */
export const SIGNATURE_LABELS = ['ผู้รับสินค้า/บริการ', 'ผู้รับเงิน', 'ผู้มีอำนาจลงนาม', 'ผู้สั่งซื้อ', 'ผู้อนุมัติ', 'ผู้รับคำสั่งซื้อ', 'ผู้ส่งของ', 'ผู้รับของ', 'ผู้วางบิล', 'ผู้รับวางบิล',
  'ผู้จัดทำ', 'ผู้ตรวจ', 'ผู้เบิก', 'ผู้จ่ายเงิน', 'ผู้เสนอราคา', 'ลูกค้ายืนยันสั่งซื้อ'];
const AUTHORISED = 'ผู้มีอำนาจลงนาม';
/** The line of the role that issued the document: the issuer's signature sits on it (if a template drops it, the last line takes it). */
const ISSUER_LINE: Partial<Record<DocType, string>> = { TI: AUTHORISED, IV: AUTHORISED, CN: AUTHORISED, DN: AUTHORISED, RC: AUTHORISED, BL: 'ผู้วางบิล', SO: 'ผู้รับคำสั่งซื้อ', DO: 'ผู้ส่งของ', QT: 'ผู้เสนอราคา',
  PO: 'ผู้สั่งซื้อ', PV: 'ผู้จัดทำ', EX: 'ผู้เบิก', JV: 'ผู้จัดทำ', WT: 'ผู้จ่ายเงิน', PR: 'ผู้จ่ายเงิน' };

export const optionsOf = (st: MockState, companyId: string, type: DocType): Pick<PrintTemplate, 'showLogo' | 'showStamp' | 'showSignature' | 'signatureLabels'> & { version: number } => {
  const t = st.printTemplates?.find((x) => x.companyId === companyId && x.type === type);
  return { showLogo: t?.showLogo ?? true, showStamp: t?.showStamp ?? true, showSignature: t?.showSignature ?? true, ...(t?.signatureLabels ? { signatureLabels: t.signatureLabels } : {}), version: t?.version ?? 1 };
};

/** The last step of every paper builder: the template's options are applied and the pictures are looked up. A template toggle is a DISPLAY option read at print time - it hides an image or a line, it never changes a frozen figure or what was snapshotted at issue.
 *  The raw model carries hashes (or, for a draft, the live logo as a data URL); the result carries data URLs. A hash with no stored picture shows nothing (the empty line stays - never a broken image). */
export function finishPaper(st: MockState, companyId: string, type: DocType, m: PaperModel): PaperModel {
  const o = optionsOf(st, companyId, type);
  const signatures = o.showSignature ? (o.signatureLabels ?? m.signatures) : [];
  const pick = (v: string | undefined) => (v === undefined ? undefined : v.startsWith('data:') ? v : st.images?.[v]);
  const logo = o.showLogo ? pick(m.images?.logo) : undefined, stamp = o.showStamp ? pick(m.images?.stamp) : undefined, signature = o.showSignature ? pick(m.images?.signature) : undefined;
  // ST4a M1: OUR signature sits only on the type's issuer line - if the template drops that line nothing is signed (never on a counterparty's line). The stamp sits on the authorised-signatory line, else on the issuer line,
  // else (no such line) beside the signature block with no line: `stampAt` absent. m3: the stamp does not depend on the lines being shown.
  const want = ISSUER_LINE[type], signatureAt = want && signatures.includes(want) ? want : undefined;
  const stampAt = signatures.includes(AUTHORISED) ? AUTHORISED : signatureAt;
  const { images: _i, issuer, ...rest } = m; void _i;
  const imgs = { ...(logo ? { logo } : {}), ...(stamp ? { stamp } : {}), ...(signature && signatureAt ? { signature } : {}) };
  const who = signature && signatureAt ? { ...(issuer?.name ? { name: issuer.name } : {}), ...(issuer?.position ? { position: issuer.position } : {}), signatureAt } : {};
  const who2 = { ...who, ...(stamp && stampAt ? { stampAt } : {}) };
  return { ...rest, signatures, ...(Object.keys(imgs).length ? { images: imgs } : {}), ...(Object.keys(who2).length ? { issuer: who2 } : {}) };
}

export interface TemplateRow { type: DocType; showLogo: boolean; showStamp: boolean; showSignature: boolean; signatureLabels: string[]; issuerLine?: string; version: number }
/** Every printable type with its options (the type's own signature labels when none are set). */
export const templatesView = (st: MockState, companyId: string, defaults: Partial<Record<DocType, string[]>>): { items: TemplateRow[]; labels: string[] } => ({
  items: PRINT_TYPES.map((type) => { const o = optionsOf(st, companyId, type); return { type, showLogo: o.showLogo, showStamp: o.showStamp, showSignature: o.showSignature, signatureLabels: o.signatureLabels ?? defaults[type] ?? [], ...(ISSUER_LINE[type] ? { issuerLine: ISSUER_LINE[type] } : {}), version: o.version }; }),
  labels: SIGNATURE_LABELS,
});

/** One Save of one type's print options. Agents are refused (§8.5); a stale version is a 409; a refusal writes nothing. */
export function updateTemplate(st: MockState, actor: Actor, companyId: string, type: string, v: Record<string, unknown>): PrintTemplate {
  if (actor.kind === 'agent') throw new MockError(403, 'agent.forbidden_setting', 'ตัวแทน (agent) เปลี่ยนการตั้งค่าไม่ได้ ต้องให้ผู้ใช้ทำเอง');
  if (!PRINT_TYPES.includes(type as DocType)) throw new MockError(404, 'template.unknown_type', 'ไม่รู้จักประเภทเอกสารนี้');
  const t = type as DocType, rows = (st.printTemplates ??= []), at = rows.findIndex((x) => x.companyId === companyId && x.type === t), cur = rows[at];
  if (v.version !== (cur?.version ?? 1)) throw new MockError(409, 'record.version_conflict', 'แม่แบบนี้ถูกแก้ไขโดยผู้อื่นแล้ว โหลดข้อมูลล่าสุดก่อนบันทึก');
  for (const k of ['showLogo', 'showStamp', 'showSignature'] as const) if (typeof v[k] !== 'boolean') throw new MockError(422, 'record.invalid', 'ข้อมูลแม่แบบไม่ถูกต้อง');
  const labels = v.signatureLabels ?? cur?.signatureLabels; // absent = keep what is stored (a Save of the toggles never pins the defaults)
  if (labels !== undefined && (!Array.isArray(labels) || labels.length < 1 || labels.length > 4 || new Set(labels).size !== labels.length || labels.some((l) => !SIGNATURE_LABELS.includes(l as string)))) {
    throw new MockError(422, 'template.bad_label', 'ชื่อผู้ลงนามต้องเลือกจากรายการที่กำหนด (1–4 ช่อง ไม่ซ้ำกัน)');
  }
  const before = optionsOf(st, companyId, t);
  const next: PrintTemplate = { companyId, type: t, showLogo: v.showLogo as boolean, showStamp: v.showStamp as boolean, showSignature: v.showSignature as boolean, ...(labels ? { signatureLabels: labels as string[] } : {}), version: (cur?.version ?? 1) + 1 };
  if (at >= 0) rows[at] = next; else rows.push(next);
  logAudit(st, actor, companyId, 'template.update', t, before, optionsOf(st, companyId, t));
  return next;
}

/** Ruling 4: every issued printable document carries a seller snapshot and every picture it refers to is in the store (a missing entry would print a broken image or none); so does a payroll return's frozen look. */
export function lookInvariants(st: MockState, out: string[]): void {
  const has = (r: string | undefined) => r === undefined || st.images?.[r] !== undefined;
  for (const d of st.docs) {
    if (!DOC_TYPES[d.type].printable || ['draft', 'pending', 'approved'].includes(d.status)) continue;
    if (!d.sellerSnapshot) out.push(`${d.id}: issued ${d.type} with no seller snapshot (I3)`);
    if (!d.issueLook) out.push(`${d.id}: issued ${d.type} with no issue look (the pictures and the issuer it was issued with)`);
    for (const k of ['logo', 'stamp', 'signature'] as const) if (!has(d.issueLook?.[k])) out.push(`${d.id}: the ${k} it was issued with (${d.issueLook?.[k]}) is not in the image store`);
  }
  for (const f of st.filings as (MockState['filings'][number] & { look?: IssueLook })[]) for (const k of ['logo', 'stamp', 'signature'] as const) if (!has(f.look?.[k])) out.push(`filing ${f.form} ${f.period}: the ${k} it was finalized with (${f.look?.[k]}) is not in the image store`);
}
