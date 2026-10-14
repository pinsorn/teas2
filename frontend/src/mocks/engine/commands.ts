import type {
  Actor, Allocation, ComputeResult, Doc, DocHeader, DocLine, DocTotals, DocType, IsoDate, JournalEntryPreview, JournalPreview, Lock, MissingItem, Money, PartySummary, Qty,
} from '@/domain/types';
import { CLASS, CONVERSIONS, DOC_TYPES, LIVE, SETTLES, isTypeAvailable } from '@/domain/doc-types';
import type { MockState } from '../store';
import { consumed, fmtQ, q4 } from './chain';
import { ledgerFor, reversalOf } from './ledger';
import { MockError, diffBody, isPinned, logActivity, logAudit, stamp, today } from './log';
import { fromSatang, toSatang } from './money';
import { SeriesAllocator } from './numbering';
import { firstOpenDate, isClosed, monthLabelTh } from './periods';
import { allocationError, balanceOf, cleanAllocations, fiscalAllocations, payDefaults, settleExtras, settleTotals } from './settlement';
import { computeDoc } from './vat';

export type Body = { header: DocHeader; lines: DocLine[]; allocations?: Allocation[] };
type Stored = MockState['docs'][number];

export { LIVE };
const sumSat = (xs: (string | undefined)[]) => xs.reduce((n, m) => n + toSatang(m ?? '0.00'), 0);
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
  isPinned() ? reversalOf(e, stamp().slice(0, 10)) // seed history: reversed on its own (pinned) date, in the period that was open then
    : isClosed(st, companyId, e.date) ? { ...reversalOf(e, firstOpenDate(st, companyId)), late: true } : reversalOf(e, today());

/** D-10: a NEW entry for a document dated in a closed month posts on the first open date, late; the document date is unchanged (I9). */
const postedNow = (st: MockState, companyId: string, p: JournalPreview): JournalPreview => {
  const [first, ...rest] = p.entries;
  return first && !isPinned() && isClosed(st, companyId, first.date) ? { entries: [{ ...first, date: firstOpenDate(st, companyId), late: true }, ...rest] } : p;
};

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
/** Document totals: the lines' totals, plus for an RC / PV the settlement money (total, WHT, cash). One seam for create / update / issue / revise / compute. */
export function totalsOf(st: MockState, companyId: string, type: DocType, body: Body): DocTotals {
  const t = calc(body).totals;
  return SETTLES[type] ? settleTotals(st, companyId, type, body, t) : t;
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
  const dep = SETTLES[type] === undefined || type !== 'RC' ? 0 : (() => { try { return toSatang(body.header.depositAmount ?? '0.00'); } catch { return 0; } })();
  if (SETTLES[type]) { // RC / PV: an allocation, a line, or (RC) a deposit is the content
    if (!body.lines.length && !body.allocations?.length && dep <= 0) {
      out.push({ field: 'allocations', message: type === 'RC' ? 'ต้องเลือกใบกำกับภาษีที่ชำระ หรือระบุเงินรับล่วงหน้า' : 'ต้องเลือกรายการที่จ่ายชำระ หรือเพิ่มรายการค่าใช้จ่าย' });
    }
  } else if (!body.lines.length) out.push({ field: 'lines', message: 'ต้องมีรายการอย่างน้อย 1 รายการ' });
  return out;
}

/** Fiscal = changes who/when/how much is taxed; only those need a chain-aware correction on a T-class document. */
export function isFiscalChange(d: Doc, b: Body): boolean {
  return b.header.partyId !== d.header.partyId || b.header.documentDate !== d.header.documentDate
    || !!b.header.priceIncludesVat !== !!d.header.priceIncludesVat || JSON.stringify(b.lines) !== JSON.stringify(d.lines)
    // settlement: who is paid how much and into which account changes the books (a certificate number does not)
    || (b.allocations !== undefined && fiscalAllocations(b.allocations) !== fiscalAllocations(d.allocations))
    || b.header.bankAccountId !== d.header.bankAccountId || b.header.whtMode !== d.header.whtMode || (b.header.depositAmount ?? '0.00') !== (d.header.depositAmount ?? '0.00');
}

/** SP0 §7.11: outstanding = total - active credit notes + active debit notes - active settlements (active links only). */
export function recomputeSettlement(st: MockState, id: string): void {
  const d = st.docs.find((x) => x.id === id);
  if (!d || !hasOut(d.type) || !LIVE.includes(d.status)) return;
  const { out, paid, settled } = balanceOf(st, d);
  // I5: 'settled' needs settlements; a TI credited to 0 by CNs alone stays 'issued' with outstanding 0.00
  const locks = [...d.locks.filter((l) => l.kind !== 'settlement'), ...(settled ? [SETTLEMENT_LOCK] : [])];
  put(st, { ...d, locks, outstanding: fromSatang(out), status: settled && out <= 0 ? 'settled' : paid > 0 ? 'partly_settled' : 'issued' });
}

/** Links a receipt to the document it settles (used by corrections, which re-create receipts). */
export function addSettlement(st: MockState, rcId: string, targetId: string, amount: Money, wht?: Money): void {
  const rc = getDoc(st, rcId);
  st.links.push({ companyId: rc.companyId, from: rcId, to: targetId, kind: 'settles', amount, active: true, ...(wht && wht !== '0.00' ? { wht } : {}) });
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

/** The body as stored: engine header defaults (RC / PV) and the cleaned allocation list. Refuses a malformed allocation, nothing semantic (that is issue's job). */
function stored(st: MockState, companyId: string, type: DocType, body: Body): Body {
  const allocations = cleanAllocations(st, companyId, type, body.allocations);
  return { header: payDefaults(st, companyId, type, body.header), lines: body.lines, ...(allocations ? { allocations } : {}) };
}

function insertDraft(st: MockState, companyId: string, type: DocType, raw: Body, actor: Actor, id?: string): Stored {
  const body = stored(st, companyId, type, raw);
  const totals = totalsOf(st, companyId, type, body);
  if (id !== undefined && st.docs.some((x) => x.id === id)) throw new MockError(409, 'doc.id_exists', `มีเอกสารรหัส ${id} อยู่แล้ว`);
  const d: Stored = {
    companyId, id: id ?? newId(st, type), type, status: 'draft', correctionClass: CLASS[type], revision: 0, version: 1,
    header: body.header, party: partyOf(st, companyId, body.header.partyId), lines: body.lines, totals, locks: [], createdBy: actor,
    ...(body.allocations ? { allocations: body.allocations } : {}),
  };
  st.docs.push(d);
  return d;
}

/** Balance of a target NOW, read from the active links (the stored field is only refreshed on read). */
const outstandingNow = (st: MockState) => (id: string): number => balanceOf(st, getDoc(st, id)).out;

export function compute(st: MockState, companyId: string, type: DocType, raw: Body): ComputeResult {
  const body = stored(st, companyId, type, raw);
  const c = calc(body);
  const totals = totalsOf(st, companyId, type, body);
  const doc: Doc = {
    id: 'preview', type, status: 'draft', correctionClass: CLASS[type], revision: 0, version: 1, header: body.header,
    party: partyOf(st, companyId, body.header.partyId), lines: body.lines, totals, locks: [], createdBy: { kind: 'user', id: '', name: '' },
    ...(body.allocations ? { allocations: body.allocations } : {}),
  };
  const missing = missingOf(st, companyId, type, body);
  const bad = allocationError(st, companyId, type, body.header, body.allocations, outstandingNow(st));
  if (bad) missing.push({ field: 'allocations', message: bad.title });
  return { lines: c.lines, totals, missing, journal: ledgerFor(st, { ...doc, companyId }), ...settleExtras(st, companyId, type, body) };
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

export function updateDraft(st: MockState, id: string, raw: Body, version: number, actor: Actor): Doc {
  const d = getDoc(st, id);
  if (d.status !== 'draft') throw new MockError(409, 'doc.not_draft', 'แก้ไขได้เฉพาะเอกสารฉบับร่าง');
  checkVersion(d, version);
  const body = stored(st, d.companyId, d.type, raw);
  const { allocations: _a, ...rest } = d; void _a;
  const next: Stored = { ...rest, header: body.header, lines: body.lines, totals: totalsOf(st, d.companyId, d.type, body), party: partyOf(st, d.companyId, body.header.partyId),
    version: d.version + 1, ...(body.allocations ? { allocations: body.allocations } : {}) };
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

/** Links an RC / PV to every target it allocates to and refreshes their balances (one `settles` link per allocation, with its own amount and WHT). */
function settleTargets(st: MockState, d: Stored, allocations: Allocation[] | undefined): void {
  for (const a of allocations ?? []) {
    st.links.push({ companyId: d.companyId, from: d.id, to: a.targetId, kind: 'settles', amount: a.amount, active: true, ...(a.wht ? { wht: a.wht } : {}) });
  }
  for (const a of allocations ?? []) recomputeSettlement(st, a.targetId);
}

/** `keepDate`: a correction re-issues a document at its original date (I9), so the period / future checks do not apply.
 *  `anyParty`: a correction may re-issue a receipt whose corrected invoice now belongs to another customer. */
export function issue(st: MockState, id: string, version: number, actor: Actor, opts?: { keepDate?: boolean; anyParty?: boolean }): Doc {
  const d = getDoc(st, id);
  if (d.status !== 'draft') throw new MockError(409, 'doc.not_draft', 'ออกได้เฉพาะเอกสารฉบับร่าง');
  checkVersion(d, version);
  const body: Body = { header: d.header, lines: d.lines, ...(d.allocations ? { allocations: d.allocations } : {}) };
  const missing = missingOf(st, d.companyId, d.type, body);
  if (missing.length) throw incomplete(missing);
  if (!opts?.keepDate) { // D-10; seed history (pinned clock) is issued as of its own date, so only the closed-period refusal is skipped
    if (d.header.documentDate > today()) throw new MockError(422, 'doc.future_date', `วันที่เอกสารอยู่ในอนาคต (วันนี้ ${today()}) ออกเอกสารไม่ได้ ให้แก้วันที่เป็นวันนี้หรือก่อนหน้า`);
    if (!isPinned() && isClosed(st, d.companyId, d.header.documentDate)) {
      throw new MockError(422, 'period.closed', `งวดบัญชี ${monthLabelTh(d.header.documentDate.slice(0, 7))} ปิดแล้ว ออกเอกสารลงวันที่ในงวดนี้ไม่ได้ ให้เปลี่ยนวันที่เป็น ${firstOpenDate(st, d.companyId)} เป็นต้นไป หรือขอเปิดงวดอีกครั้ง`);
    }
  }
  const bad = allocationError(st, d.companyId, d.type, d.header, d.allocations, outstandingNow(st), { anyParty: opts?.anyParty });
  if (bad) throw bad; // nothing has been written yet: a refused issue leaves no number, link or journal behind
  const totals = totalsOf(st, d.companyId, d.type, body);
  const next: Stored = {
    ...d, number: allocate(st, d.companyId, d.type, d.header.documentDate), status: 'issued', totals, party: partyOf(st, d.companyId, d.header.partyId),
    version: d.version + 1, issuedAt: stamp(), ...(hasOut(d.type) ? { outstanding: totals.total } : {}),
  };
  put(st, next);
  settleTargets(st, next, d.allocations);
  setJournal(st, id, postedNow(st, d.companyId, ledgerFor(st, next)));
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
export function revise(st: MockState, id: string, raw: Body, version: number, reason: string, actor: Actor): Doc {
  const d = getDoc(st, id);
  const body = stored(st, d.companyId, d.type, { ...raw, allocations: raw.allocations ?? d.allocations });
  if (!LIVE.includes(d.status)) throw new MockError(409, 'doc.not_revisable', 'แก้ไขได้เฉพาะเอกสารที่ออกแล้วและยังไม่ถูกยกเลิก');
  checkVersion(d, version);
  if (d.correctionClass === 'T' && isFiscalChange(d, body)) {
    throw new MockError(422, 'doc.revise_not_allowed', 'การแก้ไขนี้กระทบภาษี ต้องทำผ่านแผนการแก้ไข (ยกเลิก/ออกใหม่/ใบลดหนี้)');
  }
  if (d.correctionClass === 'L' && blockingLocks(d).length) throw new MockError(409, 'doc.locked', 'เอกสารถูกล็อก แก้ไขไม่ได้');
  if (d.correctionClass !== 'T') { const m = missingOf(st, d.companyId, d.type, body); if (m.length) throw incomplete(m); }
  const resettle = SETTLES[d.type] !== undefined && d.correctionClass !== 'T'; // a payment voucher re-points its own links; a receipt (T) can only change a certificate number here
  if (resettle) { // the voucher's own current links give their amounts back before the new list is checked
    const own = (tid: string) => sumSat(st.links.filter((l) => l.active && l.kind === 'settles' && l.from === id && l.to === tid).map((l) => l.amount));
    const bad = allocationError(st, d.companyId, d.type, body.header, body.allocations, (tid) => outstandingNow(st)(tid) + own(tid));
    if (bad) throw bad;
  }
  const { allocations: _a, ...rest } = d; void _a;
  const next: Stored = {
    ...rest, header: body.header, lines: body.lines, totals: totalsOf(st, d.companyId, d.type, body), party: partyOf(st, d.companyId, body.header.partyId),
    revision: d.revision + 1, version: d.version + 1, ...(body.allocations ? { allocations: body.allocations } : {}),
  };
  put(st, next);
  if (resettle) {
    const before = st.links.filter((l) => l.active && l.kind === 'settles' && l.from === id).map((l) => l.to);
    st.links = st.links.map((l) => (l.active && l.kind === 'settles' && l.from === id ? { ...l, active: false } : l));
    settleTargets(st, next, body.allocations);
    for (const t of before) recomputeSettlement(st, t);
  }
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
export function reissue(st: MockState, id: string, raw: Body, actor: Actor, reason: string): Doc {
  const old = getDoc(st, id);
  if (!LIVE.includes(old.status)) throw new MockError(409, 'doc.not_correctable', 'ออกใหม่ได้เฉพาะเอกสารที่ออกแล้วและยังไม่ถูกยกเลิก');
  if (blockingLocks(old).length) throw new MockError(409, 'doc.locked', 'เอกสารถูกล็อก ออกใหม่ไม่ได้');
  if (st.links.some((l) => l.to === id && l.active)) throw new MockError(409, 'doc.has_dependents', 'มีเอกสารอ้างอิงอยู่ ต้องยกเลิกเอกสารนั้นก่อน');
  let body = stored(st, old.companyId, old.type, { ...raw, allocations: raw.allocations ?? old.allocations });
  if (SETTLES[old.type] && fiscalAllocations(body.allocations) !== fiscalAllocations(old.allocations)) { // the links are carried as they are
    throw new MockError(422, 'doc.reissue_allocations_changed', 'ออกใหม่ต้องใช้การจัดสรรชำระเดิม ถ้าต้องการเปลี่ยนให้ยกเลิกแล้วออกใหม่');
  }
  if (old.type === 'TI' || old.type === 'RC') body = { ...body, header: { ...body.header, documentDate: old.header.documentDate } }; // I9: original date
  const missing = missingOf(st, old.companyId, old.type, body);
  if (missing.length) throw incomplete(missing);
  const totals = totalsOf(st, old.companyId, old.type, body);
  if ((old.type === 'TI' || old.type === 'RC') && totals.total !== old.totals.total) {
    throw new MockError(422, 'doc.reissue_total_changed', 'ออกใหม่ต้องใช้ยอดเดิม ยอดต่างต้องใช้ใบลดหนี้/ใบเพิ่มหนี้');
  }
  const at = stamp();
  const created: Stored = {
    companyId: old.companyId, id: newId(st, old.type), type: old.type, number: allocate(st, old.companyId, old.type, body.header.documentDate),
    status: 'issued', correctionClass: old.correctionClass, revision: 0, version: 1, header: body.header,
    party: partyOf(st, old.companyId, body.header.partyId), lines: body.lines, totals, locks: [], createdBy: actor, issuedAt: at, replacesId: old.id,
    ...(hasOut(old.type) ? { outstanding: totals.total } : {}), ...(body.allocations ? { allocations: body.allocations } : {}),
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
  setJournal(st, created.id, postedNow(st, created.companyId, ledgerFor(st, created)));
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
