import type {
  Actor, Allocation, ComputeResult, Doc, DocHeader, DocLine, DocTotals, DocType, IsoDate, JournalEntryPreview, JournalPreview, Lock, MissingItem, Money, PartySummary, Qty,
} from '@/domain/types';
import { CLASS, CONVERSIONS, DOC_TYPES, GROUPS, LIVE, SETTLES, isTypeAvailable } from '@/domain/doc-types';
import type { MockState } from '../store';
import { consumed, fmtQ, q4 } from './chain';
import { ledgerFor, reversalOf } from './ledger';
import { afterRevision, refuseClosed, refuseRejected, withAcceptedStamp } from './marks';
import { MockError, diffBody, isPinned, logActivity, logAudit, stamp, today } from './log';
import { fromSatang, toSatang } from './money';
import { SeriesAllocator } from './numbering';
import { firstOpenDate, isClosed, monthLabelTh } from './periods';
import { balanceOf, certError, cleanAllocations, fiscalAllocations, groupTotals, payDefaults, settleExtras, settleProblem, settleTotals } from './settlement';
import { computeDoc, vatOf } from './vat';

export type Body = { header: DocHeader; lines: DocLine[]; allocations?: Allocation[] };
type Stored = MockState['docs'][number];

export { LIVE };
/** Outstanding of a target with the settlements of document `docId` given back (revising that document). */
const ownBack = (st: MockState, base: (id: string) => number, docId?: string) => (tid: string): number =>
  base(tid) + (docId ? sumSat(st.links.filter((l) => l.active && l.kind === 'settles' && l.from === docId && l.to === tid).map((l) => l.amount)) : 0);
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
  isPinned() ? reversalOf(e, stamp().slice(0, 10), stamp()) // seed history: reversed on its own (pinned) date, in the period that was open then
    : isClosed(st, companyId, e.date) ? { ...reversalOf(e, firstOpenDate(st, companyId), stamp()), late: true } : reversalOf(e, today(), stamp());

/** A correction's reversal (SP0 5.9): on the ORIGINAL entry's date while that period is open, else late on the first open date. Only a user cancel posts its reversal today. */
const correctionReversal = (st: MockState, companyId: string, e: JournalEntryPreview): JournalEntryPreview =>
  isPinned() || isClosed(st, companyId, e.date) ? reverseEntry(st, companyId, e) : reversalOf(e, e.date, stamp());

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
/** `vatRegistered`: the company's flag, required (I1: a non-VAT company's lines carry VAT 0.00 whatever their tax code). */
export function calc(body: Body, vatRegistered: boolean) {
  try { return computeDoc(body.lines, !!body.header.priceIncludesVat, vatRegistered); } catch (e) {
    throw new MockError(422, 'doc.invalid_line', e instanceof Error ? e.message : 'รายการไม่ถูกต้อง');
  }
}
/** Document totals: the lines' totals, plus for an RC / PV the settlement money (total, WHT, cash). One seam for create / update / issue / revise / compute. */
export function totalsOf(st: MockState, companyId: string, type: DocType, body: Body): DocTotals {
  const t = calc(body, vatOf(st, companyId)).totals;
  return SETTLES[type] ? settleTotals(st, companyId, type, body, t) : GROUPS[type] ? groupTotals(body, t) : t;
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
  if (!body.header.documentDate) out.push({ field: 'header.documentDate', message: 'ต้องระบุวันที่เอกสาร' });
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
      out.push({ field: 'allocations', message: type === 'RC' ? (company?.vatRegistered ? 'ต้องเลือกใบกำกับภาษีที่ชำระ หรือระบุเงินรับล่วงหน้า' : 'ต้องเลือกใบแจ้งหนี้ที่ชำระ เพิ่มรายการขาย หรือระบุเงินรับล่วงหน้า') : 'ต้องเลือกรายการที่จ่ายชำระ หรือเพิ่มรายการค่าใช้จ่าย' });
    }
  } else if (GROUPS[type]) { // BL: the grouped invoices are the content
    if (!body.allocations?.length) out.push({ field: 'allocations', message: 'ต้องเลือกใบแจ้งหนี้หรือใบกำกับภาษีที่ต้องการวางบิล' });
  } else if (!body.lines.length) out.push({ field: 'lines', message: 'ต้องมีรายการอย่างน้อย 1 รายการ' });
  return out;
}

/** A money string in satang (so '5000' = '5000.00'); text that is not money is kept as is, to differ from any real amount. */
const satOf = (m: string | undefined): number | string => { try { return toSatang(m ?? '0.00'); } catch { return m ?? ''; } };
const stableJson = (o: unknown) => JSON.stringify(o, (_k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1))) : v));
/** A receipt's header without the fields an in-place edit may change (notes, reference): everything else - dimensions, cheque, ... - is evidence the books must follow. */
const rcHeaderKey = ({ notes: _n, reference: _r, depositAmount, paymentMethod, ...rest }: DocHeader) => { void _n; void _r; return stableJson({ ...rest, paymentMethod: paymentMethod ?? 'transfer', depositAmount: satOf(depositAmount) }); };

/** Fiscal = changes who/when/how much is taxed; only those need a chain-aware correction on a T-class document.
 *  A receipt takes ONLY certificate numbers, notes and reference in place: any other change is a correction (M1). */
export function isFiscalChange(d: Doc, b: Body): boolean {
  return (d.type === 'RC' && rcHeaderKey(b.header) !== rcHeaderKey(d.header)) || b.header.partyId !== d.header.partyId || b.header.documentDate !== d.header.documentDate
    || !!b.header.priceIncludesVat !== !!d.header.priceIncludesVat || JSON.stringify(b.lines) !== JSON.stringify(d.lines)
    // settlement: who is paid how much and into which account changes the books (a certificate number does not)
    || (b.allocations !== undefined && fiscalAllocations(b.allocations) !== fiscalAllocations(d.allocations))
    || b.header.bankAccountId !== d.header.bankAccountId || (b.header.paymentMethod ?? 'transfer') !== (d.header.paymentMethod ?? 'transfer') || b.header.whtMode !== d.header.whtMode || satOf(b.header.depositAmount) !== satOf(d.header.depositAmount);
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
function stored(st: MockState, companyId: string, type: DocType, body: Body, keep?: Allocation[]): Body {
  // D-12: a VAT company's receipt settles tax invoices, it never sells (a cash bill is the non-VAT company's). Shape of the request, so it is refused where the body enters.
  if (type === 'RC' && body.lines.length && vatOf(st, companyId)) throw new MockError(422, 'rc.lines_need_invoice', 'บริษัทที่จดทะเบียน VAT ต้องออกใบกำกับภาษีก่อนรับชำระ');
  const allocations = cleanAllocations(st, companyId, type, body.allocations, keep);
  return { header: payDefaults(st, companyId, type, body.header), lines: GROUPS[type] ? [] : body.lines, ...(allocations ? { allocations } : {}) };
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

/** `opts.docId`: the issued document being revised - its own active settlements are given back before the allocations are checked (same as `revise`). */
export function compute(st: MockState, companyId: string, type: DocType, raw: Body, opts?: { docId?: string }): ComputeResult {
  const body = stored(st, companyId, type, raw, opts?.docId ? st.docs.find((x) => x.id === opts.docId)?.allocations : undefined);
  const c = calc(body, vatOf(st, companyId));
  const totals = totalsOf(st, companyId, type, body);
  const doc: Doc = {
    id: 'preview', type, status: 'draft', correctionClass: CLASS[type], revision: 0, version: 1, header: body.header,
    party: partyOf(st, companyId, body.header.partyId), lines: body.lines, totals, locks: [], createdBy: { kind: 'user', id: '', name: '' },
    ...(body.allocations ? { allocations: body.allocations } : {}),
  };
  const missing = missingOf(st, companyId, type, body);
  const own = opts?.docId ? st.docs.find((x) => x.id === opts.docId) : undefined;
  const bad = settleProblem(st, companyId, type, body, ownBack(st, outstandingNow(st), opts?.docId), { prior: own?.allocations, priorParty: own?.header.partyId });
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

/** Links an RC / PV to every target it allocates to and refreshes their balances (one `settles` link per allocation, with its own amount and WHT).
 *  A BL links the same way with `groups` (informational amount, no balance effect). */
function settleTargets(st: MockState, d: Stored, allocations: Allocation[] | undefined): void {
  const kind = GROUPS[d.type] ? 'groups' : 'settles';
  for (const a of allocations ?? []) {
    st.links.push({ companyId: d.companyId, from: d.id, to: a.targetId, kind, amount: a.amount, active: true, ...(a.wht ? { wht: a.wht } : {}) });
  }
  if (kind === 'settles') for (const a of allocations ?? []) recomputeSettlement(st, a.targetId);
}

/** D-10: a document is dated today or earlier, in an open month (seed history, on the pinned clock, only skips the closed-period refusal). Issue, and revise when the date moves. */
function dateGuards(st: MockState, companyId: string, date: IsoDate): void {
  if (date > today()) throw new MockError(422, 'doc.future_date', `วันที่เอกสารอยู่ในอนาคต (วันนี้ ${today()}) ออกเอกสารไม่ได้ ให้แก้วันที่เป็นวันนี้หรือก่อนหน้า`);
  if (!isPinned() && isClosed(st, companyId, date)) {
    throw new MockError(422, 'period.closed', `งวดบัญชี ${monthLabelTh(date.slice(0, 7))} ปิดแล้ว ออกเอกสารลงวันที่ในงวดนี้ไม่ได้ ให้เปลี่ยนวันที่เป็น ${firstOpenDate(st, companyId)} เป็นต้นไป หรือขอเปิดงวดอีกครั้ง`);
  }
}

/** An invoice of 0.00 or less is not a document: cancel it instead. */
export function refuseNonPositive(st: MockState, companyId: string, type: DocType, body: Body): void {
  if (type !== 'IV') return;
  if (toSatang(totalsOf(st, companyId, type, body).total) <= 0) {
    throw new MockError(422, 'doc.total_not_positive', 'ยอดรวมใบแจ้งหนี้ต้องมากกว่า 0.00 บาท ถ้าไม่ต้องการเอกสารนี้ให้ยกเลิกเอกสาร');
  }
}

/** A document that receipts (`settles`) or a billing statement (`groups`) point at keeps its customer: their AR / list belong to that customer. */
export function refusePartyChange(st: MockState, d: Stored, body: Body): void {
  if (body.header.partyId === d.header.partyId) return;
  if (st.links.some((l) => l.active && l.to === d.id && (l.kind === 'settles' || l.kind === 'groups'))) {
    throw new MockError(422, 'doc.party_locked', 'เปลี่ยนลูกค้าไม่ได้ เพราะมีใบเสร็จหรือใบวางบิลอ้างถึงอยู่ ยกเลิกใบเสร็จ/ใบวางบิลที่อ้างถึงก่อน หรือยกเลิกใบแจ้งหนี้แล้วออกใบใหม่');
  }
}

/** `keepDate`: a correction re-issues a document at its original date (I9), so the period / future checks do not apply.
 *  `partyExempt`: target ids a correction plan retargeted to a reissued invoice, whose customer may differ from the receipt's. */
export function issue(st: MockState, id: string, version: number, actor: Actor, opts?: { keepDate?: boolean; partyExempt?: string[]; prior?: Allocation[]; priorParty?: string }): Doc {
  const d = getDoc(st, id);
  if (d.status !== 'draft') throw new MockError(409, 'doc.not_draft', 'ออกได้เฉพาะเอกสารฉบับร่าง');
  checkVersion(d, version);
  let body: Body = { header: d.header, lines: d.lines, ...(d.allocations ? { allocations: d.allocations } : {}) };
  const missing = missingOf(st, d.companyId, d.type, body);
  if (missing.length) throw incomplete(missing);
  if (!opts?.keepDate) dateGuards(st, d.companyId, d.header.documentDate); // D-10
  refuseNonPositive(st, d.companyId, d.type, body);
  const bad = settleProblem(st, d.companyId, d.type, body, outstandingNow(st), { partyExempt: opts?.partyExempt, prior: opts?.prior, priorParty: opts?.priorParty });
  if (bad) throw bad; // nothing has been written yet: a refused issue leaves no number, link or journal behind
  if (GROUPS[d.type]) body = { ...body, allocations: cleanAllocations(st, d.companyId, d.type, body.allocations) }; // BL: each target's outstanding AS OF ISSUE, server-read
  const totals = totalsOf(st, d.companyId, d.type, body);
  const next: Stored = {
    ...d, ...(body.allocations ? { allocations: body.allocations } : {}), number: allocate(st, d.companyId, d.type, d.header.documentDate), status: 'issued', totals, party: partyOf(st, d.companyId, d.header.partyId),
    version: d.version + 1, issuedAt: stamp(), ...(hasOut(d.type) ? { outstanding: totals.total } : {}),
  };
  put(st, next);
  settleTargets(st, next, body.allocations);
  setJournal(st, id, postedNow(st, d.companyId, ledgerFor(st, next)));
  st.revisions.push({ docId: id, revision: 0, at: next.issuedAt!, actor, snapshot: publicDoc(next), diff: [] });
  logActivity(st, id, actor, 'issue', next.number);
  logAudit(st, actor, d.companyId, 'doc.issue', id, { status: 'draft' }, { status: 'issued', number: next.number });
  return publicDoc(next);
}

/** `opts.correction`: the cancel is a step of a correction plan, so its reversal follows the correction rule (original date while open) instead of today. */
export function cancel(st: MockState, id: string, version: number, reasonCode: string, reasonText: string, actor: Actor, opts?: { correction?: boolean }): Doc {
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
  if (j && last && last.kind !== 'reversal') j.preview = { entries: [...j.preview.entries, (opts?.correction ? correctionReversal : reverseEntry)(st, d.companyId, last)] };
  logActivity(st, id, actor, 'cancel', reasonText);
  logAudit(st, actor, d.companyId, 'doc.cancel', id, { status: d.status }, { status: 'cancelled', reasonCode });
  return publicDoc(next);
}

/** An IV (L-class, receivable): a revision cannot take the total below what active settlements already took (T5). Equal is fine (outstanding 0.00). */
export function refuseBelowSettled(st: MockState, d: Stored, body: Body): void {
  if (d.type !== 'IV') return; // the payable side (PB / EX) keeps its own rule
  const paid = sumSat(st.links.filter((l) => l.active && l.kind === 'settles' && l.to === d.id).map((l) => l.amount));
  const total = totalsOf(st, d.companyId, d.type, body).total;
  if (toSatang(total) < paid) {
    throw new MockError(422, 'settle.below_settled', `ยอดใหม่ ${total} บาท ต่ำกว่ายอดที่รับชำระแล้ว ${fromSatang(paid)} บาท ยกเลิกหรือถอนการรับชำระก่อน`);
  }
}

/** A correction of receipt `d` is only offered when it can be issued (M4, I1): the same body shape, completeness, party and allocation rules the reissue will meet,
 *  with the receipt's own settlements given back (as the cancel step will do). Throws; reads only. */
export function refuseUnissuableReceipt(st: MockState, d: Stored, proposed: Body): void {
  const body = stored(st, d.companyId, 'RC', { ...proposed, allocations: proposed.allocations ?? d.allocations });
  const header = { ...body.header, documentDate: d.header.documentDate }; // a reissue keeps the original date
  if (header.partyId !== d.header.partyId && (body.allocations ?? []).some((a) => st.docs.find((t) => t.id === a.targetId)?.header.partyId !== header.partyId)) {
    throw new MockError(422, 'settle.party_mismatch', 'เปลี่ยนลูกค้าของใบเสร็จไม่ได้ เพราะยังจัดสรรไปยังเอกสารของลูกค้าเดิม ยกเลิกใบเสร็จแล้วออกใบใหม่ให้ลูกค้าที่ถูกต้อง');
  }
  const m = missingOf(st, d.companyId, 'RC', { ...body, header });
  if (m.length) throw incomplete(m);
  const bad = settleProblem(st, d.companyId, 'RC', { ...body, header }, ownBack(st, outstandingNow(st), d.id), { prior: d.allocations, priorParty: d.header.partyId });
  if (bad) throw bad;
}

/** A receipt revised only to record a withholding certificate (50 tawi, possibly late): the activity says which number. */
function certNote(d: Stored, body: Body): string | undefined {
  if (d.type !== 'RC') return undefined;
  const added = (body.allocations ?? []).filter((a) => a.certNumber && a.certNumber !== d.allocations?.find((o) => o.targetId === a.targetId)?.certNumber).map((a) => a.certNumber);
  return added.length ? `บันทึกเลขที่หนังสือรับรองหัก ณ ที่จ่าย ${added.join(', ')}` : undefined;
}

/** Revise in place (classes N and L). A T-class document only accepts non-fiscal changes here; fiscal ones go through a correction plan. */
export function revise(st: MockState, id: string, raw: Body, version: number, reason: string, actor: Actor): Doc {
  const d = getDoc(st, id);
  const body = stored(st, d.companyId, d.type, { ...raw, allocations: raw.allocations ?? d.allocations }, d.allocations);
  if (!LIVE.includes(d.status)) throw new MockError(409, 'doc.not_revisable', 'แก้ไขได้เฉพาะเอกสารที่ออกแล้วและยังไม่ถูกยกเลิก');
  checkVersion(d, version);
  if (d.correctionClass === 'T' && isFiscalChange(d, body)) {
    throw new MockError(422, 'doc.revise_not_allowed', 'การแก้ไขนี้กระทบภาษี ต้องทำผ่านแผนการแก้ไข (ยกเลิก/ออกใหม่/ใบลดหนี้)');
  }
  if (d.correctionClass === 'L' && blockingLocks(d).length) throw new MockError(409, 'doc.locked', 'เอกสารถูกล็อก แก้ไขไม่ได้');
  if (d.correctionClass !== 'T') { const m = missingOf(st, d.companyId, d.type, body); if (m.length) throw incomplete(m); }
  if (body.header.documentDate !== d.header.documentDate) dateGuards(st, d.companyId, body.header.documentDate); // a moved date follows the issue rules
  refusePartyChange(st, d, body);
  refuseNonPositive(st, d.companyId, d.type, body);
  refuseBelowSettled(st, d, body);
  const resettle = (SETTLES[d.type] !== undefined && d.correctionClass !== 'T') || GROUPS[d.type] !== undefined; // a payment voucher / billing statement re-points its own links; a receipt (T) can only change a certificate number here
  if (resettle) { // the voucher's own current links give their amounts back before the new list is checked
    const bad = settleProblem(st, d.companyId, d.type, body, ownBack(st, outstandingNow(st), id), { prior: d.allocations, priorParty: d.header.partyId });
    if (bad) throw bad;
  }
  if (d.type === 'RC') for (const a of body.allocations ?? []) { const bad = certError(a, a.targetNumber ?? a.targetId, toSatang(a.wht ?? '0.00')); if (bad) throw bad; } // a receipt is revised in place for its certificates only
  for (const ol of d.lines) { // a converted line cannot be lowered below what active targets (drafts hold quantity too) already took
    const taken = consumed(st, d, ol);
    const nl = body.lines.find((l) => l.id === ol.id);
    if (taken > 0 && (!nl || q4(nl.qty) < taken)) {
      throw new MockError(422, 'doc.below_converted', `รายการ “${ol.description}” แปลงไปแล้ว ${fmtQ(taken)} ${ol.unit} ลดต่ำกว่านี้หรือลบไม่ได้ ให้ยกเลิกหรือแก้ไขเอกสารปลายทางก่อน`);
    }
  }
  const { allocations: _a, ...rest } = d; void _a;
  const next: Stored = {
    ...rest, header: body.header, lines: body.lines, totals: totalsOf(st, d.companyId, d.type, body), party: partyOf(st, d.companyId, body.header.partyId),
    revision: d.revision + 1, version: d.version + 1, ...(body.allocations ? { allocations: body.allocations } : {}),
  };
  const marks = afterRevision(d); // a quotation's customer answer is void once it is revised
  if (marks) next.marks = marks; else delete next.marks;
  put(st, next);
  if (resettle) {
    const own = GROUPS[d.type] ? 'groups' : 'settles';
    const before = st.links.filter((l) => l.active && l.kind === own && l.from === id).map((l) => l.to);
    st.links = st.links.map((l) => (l.active && l.kind === own && l.from === id ? { ...l, active: false } : l));
    settleTargets(st, next, body.allocations);
    if (own === 'settles') for (const t of before) recomputeSettlement(st, t);
  }
  if (hasOut(d.type)) recomputeSettlement(st, id);
  if (d.correctionClass === 'L') {
    const prev = st.journals.find((j) => j.docId === id)?.preview.entries ?? [];
    const live = prev[prev.length - 1];
    const fresh = ledgerFor(st, getDoc(st, id)).entries[0];
    setJournal(st, id, { entries: [...prev, ...(live && live.kind !== 'reversal' ? [correctionReversal(st, d.companyId, live)] : []),
      ...(fresh ? [{ ...fresh, kind: 'correction' as const, postedAt: stamp(), ...(!isPinned() && isClosed(st, d.companyId, fresh.date) ? { date: firstOpenDate(st, d.companyId), late: true } : {}) }] : [])] });
  }
  const at = stamp();
  st.revisions.push({ docId: id, revision: next.revision, at, actor, reason, snapshot: publicDoc(getDoc(st, id)), diff: diffBody(d, body) });
  logActivity(st, id, actor, 'revise', certNote(d, body) ?? reason);
  logAudit(st, actor, d.companyId, 'doc.revise', id, { revision: d.revision }, { revision: next.revision, reason });
  return publicDoc(getDoc(st, id));
}

/** Replace an issued document by a new one (new number, `replaces` link, old one marked `replaced` and reversed in the ledger). */
export function reissue(st: MockState, id: string, raw: Body, actor: Actor, reason: string): Doc {
  const old = getDoc(st, id);
  if (!LIVE.includes(old.status)) throw new MockError(409, 'doc.not_correctable', 'ออกใหม่ได้เฉพาะเอกสารที่ออกแล้วและยังไม่ถูกยกเลิก');
  if (blockingLocks(old).length) throw new MockError(409, 'doc.locked', 'เอกสารถูกล็อก ออกใหม่ไม่ได้');
  if (st.links.some((l) => l.to === id && l.active)) throw new MockError(409, 'doc.has_dependents', 'มีเอกสารอ้างอิงอยู่ ต้องยกเลิกเอกสารนั้นก่อน');
  let body = stored(st, old.companyId, old.type, { ...raw, allocations: raw.allocations ?? old.allocations }, old.allocations);
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
  if (oj && last && last.kind !== 'reversal') oj.preview = { entries: [...oj.preview.entries, correctionReversal(st, old.companyId, last)] };
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
  refuseRejected(src);
  refuseClosed(src);
  if (SETTLES[targetType]) throw new MockError(422, 'doc.conversion_not_allowed', `แปลง ${src.type} เป็น ${targetType} ด้วยวิธีนี้ไม่ได้ (เอกสารรับ/จ่ายชำระต้องจัดสรรกับเอกสารที่ค้างชำระ)`);
  if (!CONVERSIONS[src.type]?.includes(targetType)) throw new MockError(422, 'doc.conversion_not_allowed', `แปลง ${src.type} เป็น ${targetType} ไม่ได้`);
  if (!isTypeAvailable(targetType, !!st.companies.find((c) => c.id === src.companyId)?.vatRegistered)) {
    throw new MockError(422, 'doc.type_not_available', unavailableTh(targetType));
  }
  if (GROUPS[targetType]) { // a billing statement groups the whole document: no quantities, no converted_from link (the `groups` link is made at issue)
    const d = insertDraft(st, src.companyId, targetType, {
      header: { partyId: src.header.partyId, documentDate: today(), ...(src.number ? { reference: src.number } : {}) }, lines: [],
      allocations: [{ targetId: src.id, targetType: src.type, amount: '0.00' }],
    }, actor, opts?.id);
    logActivity(st, d.id, actor, 'create', `จาก ${src.number}`);
    logAudit(st, actor, src.companyId, 'doc.convert', src.id, undefined, { target: d.id, type: targetType });
    return publicDoc(getDoc(st, d.id));
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
  const accepted = withAcceptedStamp(src, actor);
  if (accepted !== src.marks) put(st, { ...getDoc(st, src.id), marks: accepted, version: src.version + 1 });
  st.links.push({ companyId: src.companyId, from: d.id, to: src.id, kind: 'converted_from', qty: fmtQ([...wanted.values()].reduce((a, b) => a + b, 0)), active: true });
  logActivity(st, d.id, actor, 'create', `แปลงจาก ${src.number}`);
  logActivity(st, src.id, actor, 'convert', `สร้าง ${targetType} ฉบับร่าง`);
  logAudit(st, actor, src.companyId, 'doc.convert', src.id, undefined, { target: d.id, type: targetType });
  if (accepted !== src.marks) { // the customer's acceptance is recorded like a manual one: activity + audit with the marks before / after
    logActivity(st, src.id, actor, 'accept', `จากการแปลงเป็น ${targetType}`);
    logAudit(st, actor, src.companyId, 'doc.mark', src.id, { marks: src.marks }, { marks: accepted });
  }
  return publicDoc(d);
}
