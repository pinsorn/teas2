import type {
  Actor, ComputeResult, Doc, DocHeader, DocLine, DocStatus, DocType, IsoDate, JournalEntryPreview, JournalPreview, Lock, MissingItem, Money, PartySummary, Qty,
} from '@/domain/types';
import { CLASS, CONVERSIONS, DOC_TYPES, isTypeAvailable } from '@/domain/doc-types';
import type { MockState } from '../store';
import { consumed, fmtQ, q4 } from './chain';
import { ledgerFor, reversalOf } from './ledger';
import { MockError, diffBody, isPinned, logActivity, logAudit, stamp, today } from './log';
import { fromSatang, toSatang } from './money';
import { SeriesAllocator } from './numbering';
import { firstOpenDate, isClosed, monthLabelTh } from './periods';
import { computeDoc } from './vat';

export type Body = { header: DocHeader; lines: DocLine[] };
type Stored = MockState['docs'][number];

export const LIVE: DocStatus[] = ['issued', 'partly_settled', 'settled'];
const hasOut = (t: DocType) => DOC_TYPES[t].outstanding; // documents that carry an outstanding balance
const TAX_BUYER: DocType[] = ['TI', 'CN', 'DN']; // the buyer's TIN + branch must be on the document

export const unavailableTh = (t: DocType) => (DOC_TYPES[t].vat === 'vat-only' ? 'บริษัทนี้ไม่ได้จดทะเบียนภาษีมูลค่าเพิ่ม' : 'บริษัทที่จดทะเบียน VAT ใช้ใบกำกับภาษีแทนใบแจ้งหนี้');

/** I4: shown whenever an active receipt / settlement is applied; derived in recomputeSettlement so it follows settle / unsettle / cancel. */
const SETTLEMENT_LOCK: Lock = { kind: 'settlement', reason: 'มีใบเสร็จ/การชำระที่ผูกอยู่ ยกเลิกเอกสารนี้ไม่ได้', exits: ['ยกเลิกหรือถอนการชำระก่อน'] };
/** Locks that stop corrections. The settlement lock is informative (the correction plan cancels / re-issues the receipt itself) and a period lock
 *  never blocks (SP0 §7.5): the reversal and the new entry post in the first open period, labelled late. */
export const blockingLocks = (d: { locks: Lock[] }) => d.locks.filter((l) => l.kind !== 'settlement' && l.kind !== 'period');

/** Reversal of `e`: dated today, or in the first open period (late) when `e` sits in a closed one. */
const reverseEntry = (st: MockState, companyId: string, e: JournalEntryPreview): JournalEntryPreview =>
  isClosed(st, companyId, e.date) ? { ...reversalOf(e, firstOpenDate(st, companyId)), late: true } : reversalOf(e, today());

export const publicDoc = (d: Stored): Doc => { const { companyId, ...r } = d; void companyId; return structuredClone(r); };
export function getDoc(st: MockState, id: string): Stored {
  const d = st.docs.find((x) => x.id === id);
  if (!d) throw new MockError(404, 'doc.not_found', 'ไม่พบเอกสาร');
  return d;
}
const put = (st: MockState, d: Stored) => { st.docs[st.docs.findIndex((x) => x.id === d.id)] = d; };
const checkVersion = (d: Stored, v: number) => {
  if (d.version !== v) throw new MockError(409, 'doc.version_conflict', 'เอกสารถูกแก้ไขโดยผู้อื่นแล้ว กรุณาโหลดใหม่');
};
export function calc(body: Body) {
  try { return computeDoc(body.lines, !!body.header.priceIncludesVat); } catch (e) {
    throw new MockError(422, 'doc.invalid_line', e instanceof Error ? e.message : 'รายการไม่ถูกต้อง');
  }
}
function partyOf(st: MockState, companyId: string, id?: string): PartySummary | undefined {
  const p = st.parties.find((x) => x.id === id && x.companyId === companyId);
  if (!p) return undefined;
  const { companyId: c, ...rest } = p; void c;
  return rest;
}
const newId = (st: MockState, type: DocType) => {
  let n = st.docs.length + 1;
  while (st.docs.some((d) => d.id === `doc-${type.toLowerCase()}-${n}`)) n++;
  return `doc-${type.toLowerCase()}-${n}`;
};
const allocate = (st: MockState, companyId: string, type: DocType, date: IsoDate) => {
  const a = new SeriesAllocator(st.series);
  const n = a.next(companyId, type, date);
  st.series = a.toJSON();
  return n;
};
const setJournal = (st: MockState, docId: string, preview: JournalPreview) => {
  const j = st.journals.find((x) => x.docId === docId);
  if (j) j.preview = preview; else if (preview.entries.length) st.journals.push({ docId, preview });
};
const incomplete = (m: MissingItem[]) => new MockError(422, 'doc.incomplete', m.map((x) => x.message).join('; '));

export function missingOf(st: MockState, companyId: string, type: DocType, body: Body): MissingItem[] {
  const out: MissingItem[] = [];
  const company = st.companies.find((c) => c.id === companyId);
  if (!isTypeAvailable(type, !!company?.vatRegistered)) out.push({ field: 'type', message: unavailableTh(type) });
  if (!body.header.partyId) out.push({ field: 'header.partyId', message: 'ต้องเลือกคู่ค้า' });
  else {
    const p = partyOf(st, companyId, body.header.partyId);
    if (!p) out.push({ field: 'header.partyId', message: 'ไม่พบคู่ค้า' });
    else if (TAX_BUYER.includes(type) && p.vatRegistered && (!p.taxId || !p.branchCode)) {
      out.push({ field: 'header.partyId', message: 'ผู้ซื้อจดทะเบียน VAT ต้องมีเลขผู้เสียภาษีและสาขา' });
    }
  }
  if (!body.lines.length) out.push({ field: 'lines', message: 'ต้องมีรายการอย่างน้อย 1 รายการ' });
  return out;
}

/** Fiscal = changes who/when/how much is taxed; only those need a chain-aware correction on a T-class document. */
export function isFiscalChange(d: Doc, b: Body): boolean {
  return b.header.partyId !== d.header.partyId || b.header.documentDate !== d.header.documentDate
    || !!b.header.priceIncludesVat !== !!d.header.priceIncludesVat || JSON.stringify(b.lines) !== JSON.stringify(d.lines);
}

/** SP0 §7.11: outstanding = total - active credit notes + active debit notes - active settlements (active links only). */
export function recomputeSettlement(st: MockState, id: string): void {
  const d = st.docs.find((x) => x.id === id);
  if (!d || !hasOut(d.type) || !LIVE.includes(d.status)) return;
  const total = toSatang(d.totals.total);
  let out = total, paid = 0, settled = false;
  for (const l of st.links) {
    if (!l.active || l.to !== id) continue;
    const amt = toSatang(l.amount ?? '0.00');
    if (l.kind === 'settles') { out -= amt; paid += amt; settled = true; }
    else if (l.kind === 'adjusts') {
      const t = st.docs.find((x) => x.id === l.from)?.type;
      if (t === 'CN' || t === 'PCN') out -= amt; else if (t === 'DN' || t === 'PDN') out += amt;
    }
  }
  // I5: 'settled' needs settlements; a TI credited to 0 by CNs alone stays 'issued' with outstanding 0.00
  const locks = [...d.locks.filter((l) => l.kind !== 'settlement'), ...(settled ? [SETTLEMENT_LOCK] : [])];
  put(st, { ...d, locks, outstanding: fromSatang(out), status: settled && out <= 0 ? 'settled' : paid > 0 ? 'partly_settled' : 'issued' });
}

/** Links a receipt to the document it settles (used by corrections, which re-create receipts). */
export function addSettlement(st: MockState, rcId: string, targetId: string, amount: Money): void {
  const rc = getDoc(st, rcId);
  st.links.push({ companyId: rc.companyId, from: rcId, to: targetId, kind: 'settles', amount, active: true });
  recomputeSettlement(st, targetId);
}

/** Links a CN / DN to the TI it adjusts and refreshes that TI's balance. */
export function addAdjustment(st: MockState, noteId: string, targetId: string, amount: Money): void {
  const n = getDoc(st, noteId);
  st.links.push({ companyId: n.companyId, from: noteId, to: targetId, kind: 'adjusts', amount, active: true });
  recomputeSettlement(st, targetId);
}

/** A receipt cancelled earlier in a plan ends as `replaced` by its re-issue (same as a TI). */
export function markReplaced(st: MockState, oldId: string, newId: string, actor: Actor): void {
  const old = getDoc(st, oldId), nw = getDoc(st, newId);
  put(st, { ...old, status: 'replaced', replacedById: newId, version: old.version + 1 });
  put(st, { ...nw, replacesId: oldId });
  st.links.push({ companyId: old.companyId, from: newId, to: oldId, kind: 'replaces', active: true });
  logActivity(st, oldId, actor, 'reissue', `แทนที่ด้วย ${nw.number}`);
}

function insertDraft(st: MockState, companyId: string, type: DocType, body: Body, actor: Actor, id?: string): Stored {
  const totals = calc(body).totals;
  if (id !== undefined && st.docs.some((x) => x.id === id)) throw new MockError(409, 'doc.id_exists', `มีเอกสารรหัส ${id} อยู่แล้ว`);
  const d: Stored = {
    companyId, id: id ?? newId(st, type), type, status: 'draft', correctionClass: CLASS[type], revision: 0, version: 1,
    header: body.header, party: partyOf(st, companyId, body.header.partyId), lines: body.lines, totals, locks: [], createdBy: actor,
  };
  st.docs.push(d);
  return d;
}

export function compute(st: MockState, companyId: string, type: DocType, body: Body): ComputeResult {
  const c = calc(body);
  const doc: Doc = {
    id: 'preview', type, status: 'draft', correctionClass: CLASS[type], revision: 0, version: 1, header: body.header,
    party: partyOf(st, companyId, body.header.partyId), lines: body.lines, totals: c.totals, locks: [], createdBy: { kind: 'user', id: '', name: '' },
  };
  return { lines: c.lines, totals: c.totals, missing: missingOf(st, companyId, type, body), journal: ledgerFor(st, { ...doc, companyId }) };
}

/** `opts.id` is used verbatim (seed runner only; handlers never pass it). */
export function createDraft(st: MockState, companyId: string, type: DocType, body: Body, actor: Actor, idempotencyKey: string, opts?: { id?: string }): Doc {
  const key = `${companyId}|${type}|${idempotencyKey}`;
  const prior = st.idempotency?.[key];
  if (prior && st.docs.some((d) => d.id === prior)) return publicDoc(getDoc(st, prior));
  const d = insertDraft(st, companyId, type, body, actor, opts?.id);
  (st.idempotency ??= {})[key] = d.id;
  logActivity(st, d.id, actor, 'create');
  logAudit(st, actor, companyId, 'doc.create', d.id, undefined, { type, status: d.status });
  return publicDoc(d);
}

export function updateDraft(st: MockState, id: string, body: Body, version: number, actor: Actor): Doc {
  const d = getDoc(st, id);
  if (d.status !== 'draft') throw new MockError(409, 'doc.not_draft', 'แก้ไขได้เฉพาะเอกสารฉบับร่าง');
  checkVersion(d, version);
  const next: Stored = { ...d, header: body.header, lines: body.lines, totals: calc(body).totals, party: partyOf(st, d.companyId, body.header.partyId), version: d.version + 1 };
  put(st, next);
  logActivity(st, id, actor, 'update');
  logAudit(st, actor, d.companyId, 'doc.update', id, { version: d.version }, { version: next.version });
  return publicDoc(next);
}

export function deleteDraft(st: MockState, id: string, version: number, actor: Actor): void {
  const d = getDoc(st, id);
  if (d.status !== 'draft') throw new MockError(409, 'doc.not_draft', 'ลบได้เฉพาะเอกสารฉบับร่าง');
  checkVersion(d, version);
  st.docs = st.docs.filter((x) => x.id !== id);
  st.links = st.links.filter((l) => l.from !== id && l.to !== id);
  logActivity(st, id, actor, 'delete');
  logAudit(st, actor, d.companyId, 'doc.delete', id, { status: 'draft' });
}

/** `keepDate`: a correction re-issues a document at its original date (I9), so the period / future checks do not apply. */
export function issue(st: MockState, id: string, version: number, actor: Actor, opts?: { keepDate?: boolean }): Doc {
  const d = getDoc(st, id);
  if (d.status !== 'draft') throw new MockError(409, 'doc.not_draft', 'ออกได้เฉพาะเอกสารฉบับร่าง');
  checkVersion(d, version);
  const body = { header: d.header, lines: d.lines };
  const missing = missingOf(st, d.companyId, d.type, body);
  if (missing.length) throw incomplete(missing);
  if (!isPinned() && !opts?.keepDate) { // D-10; seed history is posted as of its own date
    if (d.header.documentDate > today()) throw new MockError(422, 'doc.future_date', `วันที่เอกสารอยู่ในอนาคต (วันนี้ ${today()}) ออกเอกสารไม่ได้ ให้แก้วันที่เป็นวันนี้หรือก่อนหน้า`);
    if (isClosed(st, d.companyId, d.header.documentDate)) {
      throw new MockError(422, 'period.closed', `งวดบัญชี ${monthLabelTh(d.header.documentDate.slice(0, 7))} ปิดแล้ว ออกเอกสารลงวันที่ในงวดนี้ไม่ได้ ให้เปลี่ยนวันที่เป็น ${firstOpenDate(st, d.companyId)} เป็นต้นไป หรือขอเปิดงวดอีกครั้ง`);
    }
  }
  const totals = calc(body).totals;
  const next: Stored = {
    ...d, number: allocate(st, d.companyId, d.type, d.header.documentDate), status: 'issued', totals, party: partyOf(st, d.companyId, d.header.partyId),
    version: d.version + 1, issuedAt: stamp(), ...(hasOut(d.type) ? { outstanding: totals.total } : {}),
  };
  put(st, next);
  setJournal(st, id, ledgerFor(st, next));
  st.revisions.push({ docId: id, revision: 0, at: next.issuedAt!, actor, snapshot: publicDoc(next), diff: [] });
  logActivity(st, id, actor, 'issue', next.number);
  logAudit(st, actor, d.companyId, 'doc.issue', id, { status: 'draft' }, { status: 'issued', number: next.number });
  return publicDoc(next);
}

export function cancel(st: MockState, id: string, version: number, reasonCode: string, reasonText: string, actor: Actor): Doc {
  const d = getDoc(st, id);
  if (!LIVE.includes(d.status)) throw new MockError(409, 'doc.not_cancellable', 'ยกเลิกได้เฉพาะเอกสารที่ออกแล้ว');
  checkVersion(d, version);
  // SP0 §7.5: a period lock does not block cancel (blockingLocks leaves it out); the other locks do.
  if (blockingLocks(d).length) throw new MockError(409, 'doc.locked', 'เอกสารถูกล็อก ยกเลิกไม่ได้');
  // SP0 §7.4: only an applied receipt (TI) or settlements (IV) block a cancel; N-class and CN/DN do not.
  if (st.links.some((l) => l.to === id && l.active && l.kind === 'settles')) throw new MockError(409, 'doc.has_dependents', 'มีใบเสร็จ/การชำระที่ผูกอยู่ ต้องยกเลิกหรือถอนการชำระก่อน');
  const { outstanding: _o, ...rest } = d; void _o;
  const next: Stored = { ...rest, status: 'cancelled', version: d.version + 1, cancel: { reasonCode, reasonText, at: stamp() } };
  put(st, next);
  const released = st.links.filter((l) => l.from === id && l.active);
  st.links = st.links.map((l) => (l.from === id && l.active ? { ...l, active: false } : l)); // returns converted quantity, un-settles receipts
  for (const l of released) if (l.kind === 'settles' || l.kind === 'adjusts') recomputeSettlement(st, l.to);
  const j = st.journals.find((x) => x.docId === id);
  const last = j?.preview.entries[j.preview.entries.length - 1];
  if (j && last && last.kind !== 'reversal') j.preview = { entries: [...j.preview.entries, reverseEntry(st, d.companyId, last)] };
  logActivity(st, id, actor, 'cancel', reasonText);
  logAudit(st, actor, d.companyId, 'doc.cancel', id, { status: d.status }, { status: 'cancelled', reasonCode });
  return publicDoc(next);
}

/** Revise in place (classes N and L). A T-class document only accepts non-fiscal changes here; fiscal ones go through a correction plan. */
export function revise(st: MockState, id: string, body: Body, version: number, reason: string, actor: Actor): Doc {
  const d = getDoc(st, id);
  if (!LIVE.includes(d.status)) throw new MockError(409, 'doc.not_revisable', 'แก้ไขได้เฉพาะเอกสารที่ออกแล้วและยังไม่ถูกยกเลิก');
  checkVersion(d, version);
  if (d.correctionClass === 'T' && isFiscalChange(d, body)) {
    throw new MockError(422, 'doc.revise_not_allowed', 'การแก้ไขนี้กระทบภาษี ต้องทำผ่านแผนการแก้ไข (ยกเลิก/ออกใหม่/ใบลดหนี้)');
  }
  if (d.correctionClass === 'L' && blockingLocks(d).length) throw new MockError(409, 'doc.locked', 'เอกสารถูกล็อก แก้ไขไม่ได้');
  if (d.correctionClass !== 'T') { const m = missingOf(st, d.companyId, d.type, body); if (m.length) throw incomplete(m); }
  const next: Stored = {
    ...d, header: body.header, lines: body.lines, totals: calc(body).totals, party: partyOf(st, d.companyId, body.header.partyId),
    revision: d.revision + 1, version: d.version + 1,
  };
  put(st, next);
  if (hasOut(d.type)) recomputeSettlement(st, id);
  if (d.correctionClass === 'L') {
    const prev = st.journals.find((j) => j.docId === id)?.preview.entries ?? [];
    const live = prev[prev.length - 1];
    const fresh = ledgerFor(st, getDoc(st, id)).entries[0];
    setJournal(st, id, { entries: [...prev, ...(live && live.kind !== 'reversal' ? [reverseEntry(st, d.companyId, live)] : []),
      ...(fresh ? [{ ...fresh, kind: 'correction' as const, ...(isClosed(st, d.companyId, fresh.date) ? { date: firstOpenDate(st, d.companyId), late: true } : {}) }] : [])] });
  }
  const at = stamp();
  st.revisions.push({ docId: id, revision: next.revision, at, actor, reason, snapshot: publicDoc(getDoc(st, id)), diff: diffBody(d, body) });
  logActivity(st, id, actor, 'revise', reason);
  logAudit(st, actor, d.companyId, 'doc.revise', id, { revision: d.revision }, { revision: next.revision, reason });
  return publicDoc(getDoc(st, id));
}

/** Replace an issued document by a new one (new number, `replaces` link, old one marked `replaced` and reversed in the ledger). */
export function reissue(st: MockState, id: string, body: Body, actor: Actor, reason: string): Doc {
  const old = getDoc(st, id);
  if (!LIVE.includes(old.status)) throw new MockError(409, 'doc.not_correctable', 'ออกใหม่ได้เฉพาะเอกสารที่ออกแล้วและยังไม่ถูกยกเลิก');
  if (blockingLocks(old).length) throw new MockError(409, 'doc.locked', 'เอกสารถูกล็อก ออกใหม่ไม่ได้');
  if (st.links.some((l) => l.to === id && l.active)) throw new MockError(409, 'doc.has_dependents', 'มีเอกสารอ้างอิงอยู่ ต้องยกเลิกเอกสารนั้นก่อน');
  if (old.type === 'TI' || old.type === 'RC') body = { ...body, header: { ...body.header, documentDate: old.header.documentDate } }; // I9: original date
  const missing = missingOf(st, old.companyId, old.type, body);
  if (missing.length) throw incomplete(missing);
  const totals = calc(body).totals;
  if ((old.type === 'TI' || old.type === 'RC') && totals.total !== old.totals.total) {
    throw new MockError(422, 'doc.reissue_total_changed', 'ออกใหม่ต้องใช้ยอดเดิม ยอดต่างต้องใช้ใบลดหนี้/ใบเพิ่มหนี้');
  }
  const at = stamp();
  const created: Stored = {
    companyId: old.companyId, id: newId(st, old.type), type: old.type, number: allocate(st, old.companyId, old.type, body.header.documentDate),
    status: 'issued', correctionClass: old.correctionClass, revision: 0, version: 1, header: body.header,
    party: partyOf(st, old.companyId, body.header.partyId), lines: body.lines, totals, locks: [], createdBy: actor, issuedAt: at, replacesId: old.id,
    ...(hasOut(old.type) ? { outstanding: totals.total } : {}),
  };
  const { outstanding: _o, ...oldRest } = old; void _o;
  put(st, { ...oldRest, status: 'replaced', replacedById: created.id, version: old.version + 1, cancel: { reasonCode: 'CORRECTION', reasonText: reason, at } });
  st.docs.push(created);
  const carried = st.links.filter((l) => l.from === old.id && l.active);
  st.links = st.links.map((l) => (l.from === old.id && l.active ? { ...l, active: false } : l));
  for (const l of carried) {
    st.links.push({ ...l, from: created.id, ...(l.kind === 'adjusts' ? { amount: totals.total } : {}) });
  }
  st.links.push({ companyId: old.companyId, from: created.id, to: old.id, kind: 'replaces', active: true });
  const oj = st.journals.find((j) => j.docId === old.id);
  const last = oj?.preview.entries[oj.preview.entries.length - 1];
  if (oj && last && last.kind !== 'reversal') oj.preview = { entries: [...oj.preview.entries, reverseEntry(st, old.companyId, last)] };
  setJournal(st, created.id, ledgerFor(st, created));
  st.revisions.push({ docId: created.id, revision: 0, at, actor, reason, snapshot: publicDoc(created), diff: [] });
  for (const l of carried) if (l.kind === 'settles' || l.kind === 'adjusts') recomputeSettlement(st, l.to);
  logActivity(st, old.id, actor, 'reissue', `แทนที่ด้วย ${created.number}`);
  logActivity(st, created.id, actor, 'issue', `แทนที่ ${old.number}`);
  logAudit(st, actor, old.companyId, 'doc.reissue', old.id, { status: old.status }, { replacedBy: created.id, number: created.number, reason });
  return publicDoc(getDoc(st, created.id));
}

/** Creates a draft of `targetType` from the issued source, taking `qty` of each listed source line (remaining-quantity rule). */
export function convert(st: MockState, id: string, targetType: DocType, lines: { sourceLineId: string; qty: Qty }[], actor: Actor, opts?: { id?: string }): Doc {
  const src = getDoc(st, id);
  if (!LIVE.includes(src.status)) throw new MockError(409, 'doc.not_convertible', 'แปลงได้เฉพาะเอกสารที่ออกแล้วและยังไม่ถูกยกเลิก');
  if (!CONVERSIONS[src.type]?.includes(targetType)) throw new MockError(422, 'doc.conversion_not_allowed', `แปลง ${src.type} เป็น ${targetType} ไม่ได้`);
  if (!isTypeAvailable(targetType, !!st.companies.find((c) => c.id === src.companyId)?.vatRegistered)) {
    throw new MockError(422, 'doc.type_not_available', unavailableTh(targetType));
  }
  if (!lines.length) throw new MockError(422, 'doc.incomplete', 'ต้องเลือกรายการอย่างน้อย 1 รายการ');
  const wanted = new Map<string, number>();
  for (const r of lines) {
    if (!src.lines.some((l) => l.id === r.sourceLineId)) throw new MockError(422, 'doc.line_not_found', 'ไม่พบรายการต้นทาง');
    const q = q4(r.qty);
    if (q <= 0) throw new MockError(422, 'doc.invalid_qty', 'จำนวนต้องมากกว่า 0');
    wanted.set(r.sourceLineId, (wanted.get(r.sourceLineId) ?? 0) + q);
  }
  for (const [lineId, q] of wanted) {
    const sl = src.lines.find((l) => l.id === lineId)!;
    const remaining = q4(sl.qty) - consumed(st, src, sl);
    if (q > remaining) throw new MockError(422, 'doc.over_conversion', `เกินจำนวนคงเหลือ (${sl.description}: เหลือ ${fmtQ(remaining)} ${sl.unit})`);
  }
  const draftId = opts?.id ?? newId(st, targetType);
  const newLines: DocLine[] = [...wanted].map(([lineId, q], n) => ({ ...src.lines.find((l) => l.id === lineId)!, id: `${draftId}-l${n + 1}`, qty: fmtQ(q), sourceLineId: lineId }));
  const d = insertDraft(st, src.companyId, targetType, {
    header: { partyId: src.header.partyId, documentDate: today(), ...(src.number ? { reference: src.number } : {}), priceIncludesVat: !!src.header.priceIncludesVat },
    lines: newLines,
  }, actor, opts?.id);
  st.links.push({ companyId: src.companyId, from: d.id, to: src.id, kind: 'converted_from', qty: fmtQ([...wanted.values()].reduce((a, b) => a + b, 0)), active: true });
  logActivity(st, d.id, actor, 'create', `แปลงจาก ${src.number}`);
  logActivity(st, src.id, actor, 'convert', `สร้าง ${targetType} ฉบับร่าง`);
  logAudit(st, actor, src.companyId, 'doc.convert', src.id, undefined, { target: d.id, type: targetType });
  return publicDoc(d);
}
