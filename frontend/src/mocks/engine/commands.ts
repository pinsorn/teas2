import type {
  Actor, Allocation, ComputeResult, Doc, DocHeader, DocLine, DocTotals, DocType, IsoDate, JournalEntryPreview, JournalPreview, Lock, MissingItem, Money, PartySummary, Qty, WhtFrozen,
} from '@/domain/types';
import { ADJUSTS, CLASS, CONVERSIONS, DOC_TYPES, GROUPS, LIVE, SETTLES, isTypeAvailable } from '@/domain/doc-types';
import type { MockState } from '../store';
import { approvalRequired, refuseSelfApproval, refuseUnapprovedIssue, reviseNeedsApproval, submit } from './approval';
import { dropAttachmentsOf } from './attachments';
import { consumed, fmtQ, q4 } from './chain';
import { ledgerFor, reversalOf } from './ledger';
import { afterRevision, refuseClosed, refuseRejected, withAcceptedStamp } from './marks';
import { MockError, diffBody, isPinned, logActivity, logAudit, stamp, today } from './log';
import { fromSatang, toSatang } from './money';
import { adjustSnapshot, hasSnapshot, isNote, noteHeader, noteMissing, noteProblem, withNoteVat } from './notes';
import { SeriesAllocator } from './numbering';
import { firstOpenDate, isClosed, monthLabelTh } from './periods';
import { balanceOf, certError, cleanAllocations, fiscalAllocations, freezeWht, groupTotals, payDefaults, payLines, payoutOf, settleExtras, settleProblem, settleTotals } from './settlement';
import { syncWts } from './wht-certificates';
import { cleanInvoices, isVendorBill, issueVendorStatus, purchaseProblem, snapshotCategories, snapshotWhtTypes, withClaimPeriod, withForfeit, withVendorStatus } from './purchase-vat';
import { computeDoc, vatBasisOf, vatOf } from './vat';

export type Body = { header: DocHeader; lines: DocLine[]; allocations?: Allocation[]; whtFrozen?: WhtFrozen };
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
export function totalsOf(st: MockState, companyId: string, type: DocType, body: Body, selfId?: string): DocTotals {
  const t = calc(withNoteVat(st, companyId, type, body, selfId), vatBasisOf(st, companyId, type)).totals; // a note: each line's VAT is its original line's VAT change (rule B); a vendor's invoice carries the VAT of its tax code (A.4)
  return SETTLES[type] ? settleTotals(st, companyId, type, body, t, selfId) : GROUPS[type] ? groupTotals(body, t) : t;
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
  if (isNote(type)) out.push(...noteMissing(type, body.header)); // a note's customer is its invoice's: the server fills it (stored)
  if (!body.header.partyId) { if (!isNote(type)) out.push({ field: 'header.partyId', message: 'ต้องเลือกคู่ค้า' }); }
  else {
    const p = partyOf(st, companyId, body.header.partyId);
    if (!p) out.push({ field: 'header.partyId', message: 'ไม่พบคู่ค้า' });
    else if ((type === 'EX') !== (p.kind === 'employee') && (type !== 'PV' || p.kind !== 'employee')) { // employees are their own party kind: an expense claim is owed to one, no other document (but a voucher that pays the claim) is made out to one
      out.push({ field: 'header.partyId', message: type === 'EX' ? 'ใบเบิกค่าใช้จ่ายต้องเลือกพนักงานผู้เบิก' : 'เลือกพนักงานเป็นคู่ค้าของเอกสารนี้ไม่ได้' });
    } else if (TAX_BUYER.includes(type) && p.vatRegistered && (!p.taxId || !p.branchCode)) {
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
export const stableJson = (o: unknown) => JSON.stringify(o, (_k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1))) : v));
/** A receipt's header without the fields an in-place edit may change (notes, reference): everything else - dimensions, cheque, ... - is evidence the books must follow. */
const rcHeaderKey = ({ notes: _n, reference: _r, depositAmount, paymentMethod, ...rest }: DocHeader) => { void _n; void _r; return stableJson({ ...rest, paymentMethod: paymentMethod ?? 'transfer', depositAmount: satOf(depositAmount) }); };

/** Fiscal = changes who/when/how much is taxed; only those need a chain-aware correction on a T-class document.
 *  A receipt takes ONLY certificate numbers, notes and reference in place: any other change is a correction (M1). */
/** Lines as the client knows them: the engine-set VAT of a CN / DN line is not part of what a caller can send back. */
export const sameLines = (a: DocLine[], b: DocLine[]) => JSON.stringify(a.map(({ vatOverride, ...l }) => (void vatOverride, l))) === JSON.stringify(b.map(({ vatOverride, ...l }) => (void vatOverride, l)));
/** A note whose lines are unchanged keeps its issued lines (and their VAT) and its price basis: an API caller cannot send the engine-set VAT back, and the VAT is never recomputed from today's siblings (F4). */
export const keepNoteLines = (d: Doc, body: Body): Body =>
  isNote(d.type) && sameLines(body.lines, d.lines) ? { ...body, header: { ...body.header, ...(d.header.priceIncludesVat ? { priceIncludesVat: true } : {}) }, lines: d.lines } : body;
/** R1-M4: a PB / PCN / PDN line the API sends without a category keeps its stored one (same line id); only an explicit category changes it. */
const keepCategories = (d: Doc, lines: DocLine[]): DocLine[] =>
  !isVendorBill(d.type) && d.type !== 'EX' ? lines : lines.map((l) => {
    const o = d.lines.find((x) => x.id === l.id), c = l.expenseCategory || !o?.expenseCategory ? l : { ...l, expenseCategory: o.expenseCategory };
    // EX: the vendor tax invoice of a line is what its VAT claim rests on - omitted = unchanged, an explicit null clears it (that line's VAT becomes cost), anything else replaces it
    if (d.type === 'EX') {
      if ((c.vendorInvoice as unknown) === null) { const { vendorInvoice: _v, ...rest } = c; void _v; return rest; }
      return c.vendorInvoice === undefined && o?.vendorInvoice ? { ...c, vendorInvoice: o.vendorInvoice } : c;
    }
    // C1: a bill line keeps its stored WHT type unless one is sent; an explicit null clears it ('' = none, so the item master does not refill it)
    if (d.type !== 'PB') return c;
    if ((c.whtTypeCode as string | null | undefined) === null) return { ...c, whtTypeCode: '' };
    return c.whtTypeCode === undefined && o?.whtTypeCode !== undefined ? { ...c, whtTypeCode: o.whtTypeCode } : c;
  });
/** An API proposal that leaves a field out (or sends a null bank account) means "unchanged", never "cleared": the stored bank account and dimensions stand. */
export const keepOmitted = (d: Doc, h: DocHeader): DocHeader => ({
  ...h,
  ...(h.bankAccountId == null && d.header.bankAccountId ? { bankAccountId: d.header.bankAccountId } : {}),
  ...(h.dimensions === undefined && d.header.dimensions ? { dimensions: d.header.dimensions } : {}),
});
export function isFiscalChange(d: Doc, b: Body): boolean {
  const asked = keepOmitted(d, b.header);
  return (d.type === 'RC' && rcHeaderKey(asked) !== rcHeaderKey(d.header)) || b.header.partyId !== d.header.partyId || b.header.documentDate !== d.header.documentDate
    || !!b.header.priceIncludesVat !== !!d.header.priceIncludesVat || !sameLines(b.lines, d.lines)
    // a note's invoice and reason are fiscal (ม.86/10): changing them is a correction, never an in-place edit
    || b.header.refDocId !== d.header.refDocId || b.header.reasonCode !== d.header.reasonCode || (b.header.reasonText ?? '') !== (d.header.reasonText ?? '')
    // settlement: who is paid how much and into which account changes the books (a certificate number does not)
    || (b.allocations !== undefined && fiscalAllocations(b.allocations) !== fiscalAllocations(d.allocations))
    || asked.bankAccountId !== d.header.bankAccountId ||
    // the journal carries the header dimensions (S6 carry): changing them outside a plan would leave the books on the old ones
    stableJson(asked.dimensions ?? {}) !== stableJson(d.header.dimensions ?? {}) || (b.header.paymentMethod ?? 'transfer') !== (d.header.paymentMethod ?? 'transfer') || b.header.whtMode !== d.header.whtMode || satOf(b.header.depositAmount) !== satOf(d.header.depositAmount);
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

/** Links an issued CN / DN to the TI it adjusts (the one link-writer: `issue`) and refreshes that TI's balance. */
function adjustTarget(st: MockState, n: Stored, amount: Money): void {
  st.links.push({ companyId: n.companyId, from: n.id, to: n.header.refDocId!, kind: 'adjusts', amount, active: true });
  recomputeSettlement(st, n.header.refDocId!);
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
function stored(st: MockState, companyId: string, type: DocType, body: Body, keep?: Allocation[], prev?: DocHeader): Body {
  // D-12: a VAT company's receipt settles tax invoices, it never sells (a cash bill is the non-VAT company's). Shape of the request, so it is refused where the body enters.
  if (type === 'RC' && body.lines.length && vatOf(st, companyId)) throw new MockError(422, 'rc.lines_need_invoice', 'บริษัทที่จดทะเบียน VAT ต้องออกใบกำกับภาษีก่อนรับชำระ');
  const allocations = cleanAllocations(st, companyId, type, body.allocations, keep);
  return { header: withForfeit(st, companyId, type, withVendorStatus(st, companyId, type, noteHeader(st, companyId, type, payDefaults(st, companyId, type, body.header), body.lines), prev)), lines: GROUPS[type] ? [] : payLines(st, companyId, type, body.header, vendorNoteLines(st, companyId, type, body)), ...(allocations ? { allocations } : {}) };
}

/** C1: every PB / PCN / PDN line stores its resolved expense category (the item's, when the line names none). A PCN / PDN line takes the category (and item) of the bill line it adjusts,
 *  server-side, at save, revise AND issue: the VAT it gives back is claimable exactly when the bill's was, whatever the draft carried. */
function vendorNoteLines(st: MockState, companyId: string, type: DocType, body: Body): DocLine[] {
  const snap = isVendorBill(type) || type === 'PV' || type === 'EX' ? snapshotCategories(st, companyId, type === 'EX' ? cleanInvoices(body.lines) : body.lines) : body.lines; // a voucher's own lines too: the category stays what was chosen
  const lines = type === 'PB' ? snapshotWhtTypes(st, companyId, snap) : snap; // C1: a bill stores the WHT type of each line
  const pb = ADJUSTS[type] === 'PB' ? st.docs.find((d) => d.id === body.header.refDocId && d.companyId === companyId && d.type === 'PB') : undefined;
  if (!pb) return lines;
  return lines.map((l) => {
    const src = l.sourceLineId ? pb.lines.find((x) => x.id === l.sourceLineId) : undefined;
    if (!src) return l;
    const { expenseCategory: _c, itemId: _i, ...rest } = l; void _c; void _i;
    return { ...rest, ...(src.itemId ? { itemId: src.itemId } : {}), ...(src.expenseCategory ? { expenseCategory: src.expenseCategory } : {}) };
  });
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

/** Exactly one voucher holds a bill's paid-up record (`full` + `billBase`, I1): the one whose command brought the outstanding to 0 last. After a voucher command: a bill still owing has no record at all
 *  (the command reopened it), and when this voucher holds the record on a bill, every other voucher's copy on that bill goes. Nothing can be stale, so the invariant never has to choose between records. */
function settlePaidUpRecords(st: MockState, pvId: string, bills: string[]): void {
  for (const billId of new Set(bills)) {
    const bill = st.docs.find((x) => x.id === billId && x.type === 'PB');
    if (!bill || !LIVE.includes(bill.status)) continue;
    const owing = balanceOf(st, bill).out > 0;
    const mine = st.docs.find((x) => x.id === pvId)?.whtFrozen?.bases.some((b) => b.targetId === billId && b.full);
    for (const d of st.docs.filter((x) => x.type === 'PV' && x.whtFrozen?.bases.some((b) => b.targetId === billId && b.full))) {
      if (!owing && (mine ? d.id === pvId : true)) continue; // a voucher keeps its record while the bill is paid up (and keeps it when it is not the one that just acted)
      put(st, { ...d, whtFrozen: { ...d.whtFrozen!, bases: d.whtFrozen!.bases.map((b) => { if (b.targetId !== billId) return b; const { full: _f, billBase: _b, ...rest } = b; void _f; void _b; return rest; }) } });
    }
  }
}

/** C1: a PV's withholding figures are fixed with the voucher. Kept as stored while nothing that feeds them changed (own lines, allocations, mode, payee, date, price basis), else taken afresh (I1). */
function withWht(st: MockState, companyId: string, type: DocType, body: Body, own?: Stored): Body {
  if (type !== 'PV') return body;
  const same = !!own?.whtFrozen && sameLines(body.lines, own.lines) && fiscalAllocations(body.allocations) === fiscalAllocations(own.allocations) && body.header.whtMode === own.header.whtMode
    && body.header.partyId === own.header.partyId && body.header.documentDate === own.header.documentDate && !!body.header.priceIncludesVat === !!own.header.priceIncludesVat;
  return { ...body, whtFrozen: same ? own!.whtFrozen : freezeWht(st, companyId, body, own?.id) };
}

/** `opts.docId`: the issued document being revised - its own active settlements are given back before the allocations are checked (same as `revise`). */
export function compute(st: MockState, companyId: string, type: DocType, raw: Body, opts?: { docId?: string }): ComputeResult {
  const own0 = opts?.docId ? st.docs.find((x) => x.id === opts.docId) : undefined;
  const body = withWht(st, companyId, type, withNoteVat(st, companyId, type, stored(st, companyId, type, raw, own0?.allocations, own0?.header), opts?.docId), own0);
  const c = calc(body, vatBasisOf(st, companyId, type));
  const totals = totalsOf(st, companyId, type, body, opts?.docId);
  const doc: Doc = {
    id: 'preview', type, status: 'draft', correctionClass: CLASS[type], revision: 0, version: 1, header: body.header,
    party: partyOf(st, companyId, body.header.partyId), lines: body.lines, totals, locks: [], createdBy: { kind: 'user', id: '', name: '' },
    ...(body.allocations ? { allocations: body.allocations } : {}), ...(body.whtFrozen ? { whtFrozen: body.whtFrozen } : {}),
  };
  const missing = missingOf(st, companyId, type, body);
  const own = opts?.docId ? st.docs.find((x) => x.id === opts.docId) : undefined;
  const bad = settleProblem(st, companyId, type, body, ownBack(st, outstandingNow(st), opts?.docId), { prior: own?.allocations, priorParty: own?.header.partyId });
  if (bad) missing.push(bad.code === 'pv.input_vat_needs_bill' ? { field: 'lines', message: bad.title, code: bad.code } : { field: 'allocations', message: bad.title });
  const np = noteProblem(st, companyId, type, body, opts?.docId);
  if (np) missing.push({ field: 'lines', message: np.title }); // the cap, the invoice's lines: shown before issue
  const pp = purchaseProblem(st, companyId, type, body); // input VAT rules of a vendor's invoice: shown before issue too
  if (pp) missing.push({ field: ({ 'pb.claim_period_out_of_range': 'header.claimPeriod', 'pcn.claim_period_fixed': 'header.claimPeriod', 'pb.vendor_invoice_after_document': 'header.vendorDocDate' } as Record<string, string>)[pp.code] ?? 'lines', message: pp.title });
  return { lines: c.lines, totals, missing, journal: ledgerFor(st, { ...doc, companyId }), ...settleExtras(st, companyId, type, body),
    ...((opts?.docId ? !!own0 && LIVE.includes(own0.status) && reviseNeedsApproval(st, own0, payoutOf(st, companyId, { ...doc, id: opts.docId }), doc.allocations) : approvalRequired(st, companyId, type, payoutOf(st, companyId, doc))) ? { approvalRequired: true } : {}) }; // the editor swaps issue for submit / approve-and-issue (§7.6), and a revise that raises the money above what was approved asks for the approver (C1)
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

/** Did a save change the money of the document (its total, its lines or who is paid how much)? That person becomes `moneyBy` (I2). */
const moneyChanged = (d: Stored, total: Money, body: Body): boolean =>
  total !== d.totals.total || !sameLines(body.lines, d.lines) || fiscalAllocations(body.allocations) !== fiscalAllocations(d.allocations);

export function updateDraft(st: MockState, id: string, raw: Body, version: number, actor: Actor): Doc {
  const d = getDoc(st, id);
  if (d.status === 'pending') throw new MockError(409, 'approval.pending', 'เอกสารนี้รออนุมัติ แก้ไขไม่ได้ ให้ผู้อนุมัติส่งกลับแก้ไขก่อน');
  if (d.status !== 'draft' && d.status !== 'approved') throw new MockError(409, 'doc.not_draft', 'แก้ไขได้เฉพาะเอกสารฉบับร่าง');
  checkVersion(d, version);
  const body = stored(st, d.companyId, d.type, raw, undefined, d.header);
  const { allocations: _a, approval: _ap, ...rest } = d; void _a; void _ap; // editing an approved document returns it to draft (§7.6): the approval goes, it must be sent again
  const totals = totalsOf(st, d.companyId, d.type, body);
  const next: Stored = { ...rest, status: 'draft', header: body.header, lines: body.lines, totals, party: partyOf(st, d.companyId, body.header.partyId),
    version: d.version + 1, ...(body.allocations ? { allocations: body.allocations } : {}), ...(moneyChanged(d, totals.total, body) ? { moneyBy: actor } : {}) }; // I2: the one who changed the money
  put(st, next);
  if (d.status === 'approved') logActivity(st, id, actor, 'send_back', 'แก้ไขหลังอนุมัติ ต้องส่งอนุมัติใหม่');
  logActivity(st, id, actor, 'update');
  logAudit(st, actor, d.companyId, 'doc.update', id, { version: d.version }, { version: next.version });
  return publicDoc(next);
}

export function deleteDraft(st: MockState, id: string, version: number, actor: Actor): void {
  const d = getDoc(st, id);
  if (d.status !== 'draft') throw new MockError(409, 'doc.not_draft', d.status === 'pending' || d.status === 'approved' ? 'ลบเอกสารที่ส่งอนุมัติแล้วไม่ได้ ให้ผู้อนุมัติส่งกลับแก้ไขก่อน แล้วลบฉบับร่าง' : 'ลบได้เฉพาะเอกสารฉบับร่าง');
  checkVersion(d, version);
  st.docs = st.docs.filter((x) => x.id !== id);
  st.links = st.links.filter((l) => l.from !== id && l.to !== id);
  dropAttachmentsOf(st, id);
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

/** An invoice, a purchase bill or a note of 0.00 or less is not a document: cancel it instead. */
export function refuseNonPositive(st: MockState, companyId: string, type: DocType, body: Body, selfId?: string): void {
  if (type !== 'IV' && type !== 'PB' && type !== 'EX' && !isNote(type)) return;
  if (toSatang(totalsOf(st, companyId, type, body, selfId).total) <= 0) {
    throw new MockError(422, 'doc.total_not_positive', `ยอดรวม${({ IV: 'ใบแจ้งหนี้', PB: 'บันทึกซื้อ', EX: 'ใบเบิกค่าใช้จ่าย', CN: 'ใบลดหนี้', PCN: 'ใบลดหนี้จากผู้ขาย', PDN: 'ใบเพิ่มหนี้จากผู้ขาย' } as Partial<Record<DocType, string>>)[type] ?? 'ใบเพิ่มหนี้'}ต้องมากกว่า 0.00 บาท ถ้าไม่ต้องการเอกสารนี้ให้ยกเลิกเอกสาร`);
  }
}

/** A document that receipts / vouchers (`settles`), a billing statement (`groups`) or a note (`adjusts`) point at keeps its customer / vendor: their AR / AP and the note's own party belong to it. */
export function refusePartyChange(st: MockState, d: Stored, body: Body): void {
  if (body.header.partyId === d.header.partyId) return;
  if (d.type === 'EX') throw new MockError(422, 'doc.party_locked', 'เปลี่ยนพนักงานผู้เบิกของใบเบิกค่าใช้จ่ายที่ออกแล้วไม่ได้ เพราะเจ้าหนี้พนักงาน (2180) บันทึกในชื่อพนักงานเดิม ยกเลิกใบเบิกแล้วบันทึกใหม่');
  if (d.type === 'PV') throw new MockError(422, 'doc.party_locked', 'เปลี่ยนผู้รับเงินของใบสำคัญจ่ายที่ออกแล้วไม่ได้ เพราะหนังสือรับรองหัก ณ ที่จ่ายออกในนามผู้รับเงินเดิม ยกเลิกใบสำคัญจ่ายแล้วออกใบใหม่');
  if (st.links.some((l) => l.active && l.to === d.id && (l.kind === 'settles' || l.kind === 'groups' || l.kind === 'adjusts'))) {
    const notes = !st.links.some((l) => l.active && l.to === d.id && (l.kind === 'settles' || l.kind === 'groups'));
    throw new MockError(422, 'doc.party_locked', notes ? 'เปลี่ยนผู้ขายไม่ได้ เพราะมีใบลดหนี้/ใบเพิ่มหนี้จากผู้ขายอ้างถึงอยู่ ยกเลิกใบลดหนี้/ใบเพิ่มหนี้ก่อน หรือยกเลิกบันทึกซื้อแล้วบันทึกใหม่'
      : 'เปลี่ยนลูกค้า/ผู้ขายไม่ได้ เพราะมีใบเสร็จ ใบสำคัญจ่าย หรือใบวางบิลอ้างถึงอยู่ ยกเลิกใบเสร็จ/ใบวางบิลที่อ้างถึงก่อน หรือยกเลิกเอกสารนี้แล้วออกใบใหม่');
  }
}

/** `keepDate`: a correction re-issues a document at its original date (I9), so the period / future checks do not apply.
 *  `partyExempt`: target ids a correction plan retargeted to a reissued invoice, whose customer may differ from the receipt's. */
export function issue(st: MockState, id: string, version: number, actor: Actor, opts?: { keepDate?: boolean; partyExempt?: string[]; prior?: Allocation[]; priorParty?: string; /** approve-and-issue (§7.6): this person approves in the same command */ approver?: Actor }): Doc {
  const d = getDoc(st, id);
  if (d.status !== 'draft' && d.status !== 'approved' && d.status !== 'pending') throw new MockError(409, 'doc.not_draft', 'ออกได้เฉพาะเอกสารฉบับร่าง');
  checkVersion(d, version);
  if (!opts?.approver) refuseUnapprovedIssue(st, d); // a document the policy wants approved issues only from `approved`: nothing below has run, so a refusal leaves no number, link or journal
  const header0 = issueVendorStatus(st, d.companyId, d.type, d.header); // R1-M2: the vendor's VAT status as of issue
  let body: Body = { header: header0, lines: vendorNoteLines(st, d.companyId, d.type, { header: header0, lines: d.lines }), ...(d.allocations ? { allocations: d.allocations } : {}) }; // C1: categories as of now
  const missing = missingOf(st, d.companyId, d.type, body);
  if (missing.length) throw incomplete(missing);
  if (!opts?.keepDate) dateGuards(st, d.companyId, d.header.documentDate); // D-10
  refuseNonPositive(st, d.companyId, d.type, body);
  const np = noteProblem(st, d.companyId, d.type, body); // the invoice, its lines and the per-line cap, judged before anything is written
  if (np) throw np;
  const pp = purchaseProblem(st, d.companyId, d.type, body); // a vendor's invoice: the registered-vendor, category and claim-window rules
  if (pp) throw pp;
  refuseOverConversion(st, d, body);
  body = { ...body, header: withClaimPeriod(st, d.companyId, d.type, body.header) }; // the document month unless a period was chosen
  body = withWht(st, d.companyId, d.type, body); // a voucher: the WHT as of now, fixed from here on (C1)
  const bad = settleProblem(st, d.companyId, d.type, body, outstandingNow(st), { partyExempt: opts?.partyExempt, prior: opts?.prior, priorParty: opts?.priorParty });
  if (bad) throw bad; // nothing has been written yet: a refused issue leaves no number, link or journal behind
  if (GROUPS[d.type]) body = { ...body, allocations: cleanAllocations(st, d.companyId, d.type, body.allocations) }; // BL: each target's outstanding AS OF ISSUE, server-read
  body = withNoteVat(st, d.companyId, d.type, body); // a CN / DN keeps the VAT its lines carry at issue
  const totals = totalsOf(st, d.companyId, d.type, body);
  const next: Stored = {
    ...d, header: body.header, lines: body.lines, ...(body.allocations ? { allocations: body.allocations } : {}), ...(body.whtFrozen ? { whtFrozen: body.whtFrozen } : {}), number: allocate(st, d.companyId, d.type, d.header.documentDate), status: 'issued', totals, party: partyOf(st, d.companyId, d.header.partyId),
    version: d.version + 1, issuedAt: stamp(), ...(hasOut(d.type) ? { outstanding: totals.total } : {}),
    ...(opts?.approver ? { approval: { submittedBy: d.approval?.submittedBy ?? actor, submittedAt: d.approval?.submittedAt ?? stamp(), approvedBy: opts.approver, approvedAt: stamp(), amount: payoutOf(st, d.companyId, { ...d, ...body, totals }) } } : {}),
  };
  if (hasSnapshot(d.type)) next.adjustSnapshot = adjustSnapshot(st, getDoc(st, d.header.refDocId!), next); // the ม.86/10 values as of now: the paper reads them, never recomputes
  put(st, next);
  settleTargets(st, next, body.allocations);
  if (isNote(d.type)) adjustTarget(st, next, totals.total);
  setJournal(st, id, postedNow(st, d.companyId, ledgerFor(st, next)));
  if (d.type === 'PV') { syncWts(st, id, actor); settlePaidUpRecords(st, id, (next.allocations ?? []).map((a) => a.targetId)); } // the 50 tawi, one per WHT type, in the same command (one state write)
  st.revisions.push({ docId: id, revision: 0, at: next.issuedAt!, actor, snapshot: publicDoc(next), diff: [] });
  if (opts?.approver) { if (d.status === 'draft') logActivity(st, id, actor, 'submit'); logActivity(st, id, opts.approver, 'approve'); }
  logActivity(st, id, actor, 'issue', next.number);
  logAudit(st, actor, d.companyId, 'doc.issue', id, { status: d.status }, { status: 'issued', number: next.number });
  return publicDoc(next);
}

/** Sends a draft for approval (§7.6) - but only a document that could be issued: the approver never receives an incomplete one. */
export function submitForApproval(st: MockState, id: string, version: number, actor: Actor): Doc {
  const d = getDoc(st, id);
  if (d.status === 'draft') {
    const body: Body = { header: d.header, lines: d.lines, ...(d.allocations ? { allocations: d.allocations } : {}) };
    const missing = missingOf(st, d.companyId, d.type, body);
    if (missing.length) throw incomplete(missing);
    refuseNonPositive(st, d.companyId, d.type, body);
    const pp = purchaseProblem(st, d.companyId, d.type, body);
    if (pp) throw pp;
  }
  return submit(st, id, version, actor);
}

/** One action for a person who holds both rights (§7.6): approve and issue in a single command - one number, one journal. A document the policy does not need approved simply issues. */
export function approveAndIssue(st: MockState, id: string, version: number, actor: Actor): Doc {
  const d = getDoc(st, id);
  if (d.status !== 'draft' && d.status !== 'pending') throw new MockError(409, 'approval.not_approvable', 'อนุมัติและออกได้เฉพาะเอกสารฉบับร่างหรือที่รออนุมัติ');
  checkVersion(d, version);
  if (d.status === 'draft' && !approvalRequired(st, d.companyId, d.type, payoutOf(st, d.companyId, d))) return issue(st, id, version, actor);
  refuseSelfApproval(st, d, actor);
  return issue(st, id, version, actor, { approver: actor });
}

/** `opts.correction`: the cancel is a step of a correction plan, so its reversal follows the correction rule (original date while open) instead of today. */
export function cancel(st: MockState, id: string, version: number, reasonCode: string, reasonText: string, actor: Actor, opts?: { correction?: boolean }): Doc {
  const d = getDoc(st, id);
  if (!LIVE.includes(d.status)) throw new MockError(409, 'doc.not_cancellable', d.status === 'pending' || d.status === 'approved' ? 'ยังไม่ได้ออกเอกสาร ยกเลิกไม่ได้ ให้ผู้อนุมัติส่งกลับแก้ไขก่อน แล้วลบฉบับร่าง' : 'ยกเลิกได้เฉพาะเอกสารที่ออกแล้ว');
  checkVersion(d, version);
  // SP0 §7.5: a period lock does not block cancel (blockingLocks leaves it out); the other locks do.
  if (blockingLocks(d).length) throw new MockError(409, 'doc.locked', 'เอกสารถูกล็อก ยกเลิกไม่ได้');
  // SP0 §7.4: an applied receipt (TI) or settlements (IV) block a cancel; N-class documents and a CN / DN being cancelled do not. S5 adds: a TI with a live CN / DN against it (below).
  if (st.links.some((l) => l.to === id && l.active && l.kind === 'settles')) throw new MockError(409, 'doc.has_dependents', 'มีใบเสร็จ/การชำระที่ผูกอยู่ ต้องยกเลิกหรือถอนการชำระก่อน');
  // invariant 10: every live note adjusts a live TI, and a cancelled invoice with a live note would reverse its receivable twice (AR 1130 vs the subledger): cancel the notes first
  if (st.links.some((l) => l.to === id && l.active && l.kind === 'adjusts')) throw new MockError(409, 'doc.has_dependents', 'มีใบลดหนี้/ใบเพิ่มหนี้อ้างอิงอยู่ ต้องยกเลิกใบลดหนี้/ใบเพิ่มหนี้ก่อน');
  const { outstanding: _o, ...rest } = d; void _o;
  const next: Stored = { ...rest, status: 'cancelled', version: d.version + 1, cancel: { reasonCode, reasonText, at: stamp() } };
  put(st, next);
  if (d.type === 'PV') syncWts(st, id, actor); // a cancelled voucher withholds nothing: its certificates are cancelled with it
  const released = st.links.filter((l) => l.from === id && l.active);
  st.links = st.links.map((l) => (l.from === id && l.active ? { ...l, active: false } : l)); // returns converted quantity, un-settles receipts
  for (const l of released) if (l.kind === 'settles' || l.kind === 'adjusts') recomputeSettlement(st, l.to);
  if (d.type === 'PV') settlePaidUpRecords(st, id, (d.allocations ?? []).map((a) => a.targetId)); // the bills it paid are open again: their paid-up record goes
  const j = st.journals.find((x) => x.docId === id);
  const last = j?.preview.entries[j.preview.entries.length - 1];
  if (j && last && last.kind !== 'reversal') j.preview = { entries: [...j.preview.entries, (opts?.correction ? correctionReversal : reverseEntry)(st, d.companyId, last)] };
  logActivity(st, id, actor, 'cancel', reasonText);
  logAudit(st, actor, d.companyId, 'doc.cancel', id, { status: d.status }, { status: 'cancelled', reasonCode });
  return publicDoc(next);
}

/** An IV or a PB (L-class, receivable / payable): a revision cannot take the total below what active settlements already took (T5). Equal is fine (outstanding 0.00). */
export function refuseBelowSettled(st: MockState, d: Stored, body: Body): void {
  if (d.type !== 'IV' && d.type !== 'PB' && d.type !== 'EX') return;
  const paid = sumSat(st.links.filter((l) => l.active && l.kind === 'settles' && l.to === d.id).map((l) => l.amount));
  const total = totalsOf(st, d.companyId, d.type, body).total;
  if (toSatang(total) < paid) {
    throw new MockError(422, 'settle.below_settled', d.type === 'PB' || d.type === 'EX' ? `ยอดใหม่ ${total} บาท ต่ำกว่ายอดที่จ่ายชำระแล้ว ${fromSatang(paid)} บาท ยกเลิกหรือถอนการจ่ายชำระก่อน` : `ยอดใหม่ ${total} บาท ต่ำกว่ายอดที่รับชำระแล้ว ${fromSatang(paid)} บาท ยกเลิกหรือถอนการรับชำระก่อน`);
  }
}

/** D-29: a bill made from a PO never takes more than the PO line has left, whatever it was edited to after the conversion (issue and revise; the other bills and drafts already hold their share). */
export function refuseOverConversion(st: MockState, d: Stored, body: Body): void {
  if (d.type !== 'PB') return;
  for (const l of st.links.filter((x) => x.active && x.kind === 'converted_from' && x.from === d.id)) {
    const src = getDoc(st, l.to);
    for (const sl of src.lines) {
      const mine = body.lines.filter((x) => x.sourceLineId === sl.id).reduce((a, x) => a + q4(x.qty), 0);
      const left = q4(sl.qty) - consumed(st, src, sl, (t) => t.id !== d.id);
      if (mine > left) throw new MockError(422, 'doc.over_conversion', `เกินจำนวนคงเหลือ (${sl.description}: เหลือ ${fmtQ(Math.max(0, left))} ${sl.unit})`);
    }
  }
}

/** A bill a live PCN / PDN adjusts keeps its lines, price basis and date (the notes reference its lines and are dated from it): exit = cancel the notes, or issue a further note. */
function refuseFrozenByNotes(st: MockState, d: Stored, body: Body): void {
  if (d.type !== 'PB') return;
  const changed = !sameLines(body.lines, d.lines) || !!body.header.priceIncludesVat !== !!d.header.priceIncludesVat || body.header.documentDate !== d.header.documentDate || (body.header.vendorDocDate || undefined) !== d.header.vendorDocDate;
  if (changed && st.links.some((l) => l.active && l.kind === 'settles' && l.to === d.id)) { // what a voucher withheld on is what the bill said: cancel the voucher (its certificates go with it) to change it
    throw new MockError(422, 'pb.settled_locked', 'แก้ไขรายการ ราคา วันที่ หรือวันที่ใบกำกับภาษีของผู้ขายของบันทึกซื้อนี้ไม่ได้ เพราะมีใบสำคัญจ่ายชำระอยู่ ยกเลิกใบสำคัญจ่ายก่อน');
  }
  if (!changed || !st.links.some((l) => l.active && l.kind === 'adjusts' && l.to === d.id)) return;
  throw new MockError(422, 'pb.has_notes', 'แก้ไขรายการ ราคา วันที่ หรือวันที่ใบกำกับภาษีของผู้ขายของบันทึกซื้อนี้ไม่ได้ เพราะมีใบลดหนี้/ใบเพิ่มหนี้จากผู้ขายอ้างถึงอยู่ ยกเลิกใบลดหนี้/ใบเพิ่มหนี้ก่อน หรือบันทึกใบลดหนี้/ใบเพิ่มหนี้เพิ่ม');
}

/** Everything that makes a revision of a PB / PCN / PDN unacceptable, judged before anything is written (also for the correction plan, which must not offer what would fail).
 *  A note keeps the bill it adjusts; its lines, cap and VAT are judged as at issue, the note itself not counting among its predecessors. */
export function refuseUnrevisablePurchase(st: MockState, d: Stored, body: Body): void {
  if (ADJUSTS[d.type] === 'PB') {
    if (body.header.refDocId !== d.header.refDocId) throw new MockError(422, 'note.ref_locked', 'เปลี่ยนบันทึกซื้อที่อ้างอิงไม่ได้ ให้ยกเลิกเอกสารนี้แล้วบันทึกใหม่');
    const np = noteProblem(st, d.companyId, d.type, body, d.id);
    if (np) throw np;
  } else if (d.type === 'PB') refuseFrozenByNotes(st, d, body);
  else if (d.type !== 'EX') return;
  const pp = purchaseProblem(st, d.companyId, d.type, body);
  if (pp) throw pp;
  refuseOverConversion(st, d, body);
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
function reviseBody(st: MockState, d: Stored, raw: Body): Body {
  const keepBank = keepOmitted(d, raw.header); // absent bank account / dimensions mean "unchanged": the company default must not fill the bank in (it would read as a move)
  const sent = stored(st, d.companyId, d.type, { ...raw, header: keepBank, lines: keepCategories(d, raw.lines), allocations: raw.allocations ?? d.allocations }, d.allocations, d.header);
  const kept = keepNoteLines(d, sent); // an API caller cannot send the engine-set VAT back: the issued lines stand
  return withWht(st, d.companyId, d.type, kept, d); // C1: the stored WHT stands unless the voucher's own money changed
}

/** C1: would revising `d` to `raw` need an approver? (A correction plan asks before it is shown.) Throws what the revise itself would on a malformed body. */
export const reviseNeedsApprover = (st: MockState, d: Stored, raw: Body): boolean => {
  const b = reviseBody(st, d, raw);
  return reviseNeedsApproval(st, d, payoutOf(st, d.companyId, { id: d.id, type: d.type, ...b, totals: totalsOf(st, d.companyId, d.type, b, d.id) }), b.allocations);
};
export const approvalOnRevise = () => new MockError(422, 'approval.required_on_revise', 'การแก้ไขนี้ทำให้ยอดสูงกว่ายอดที่ได้รับอนุมัติ ต้องได้รับอนุมัติใหม่ ให้ผู้มีสิทธิ์อนุมัติเป็นผู้แก้ไข (หรือยกเลิกแล้วสร้างใหม่และส่งอนุมัติ)');

/** `opts.approver`: the person who also approves this revise (C1) - the caller passes one only if they hold the approve right. */
export function revise(st: MockState, id: string, raw: Body, version: number, reason: string, actor: Actor, opts?: { approver?: Actor }): Doc {
  const d = getDoc(st, id);
  const body = reviseBody(st, d, raw);
  if (!LIVE.includes(d.status)) throw new MockError(409, 'doc.not_revisable', 'แก้ไขได้เฉพาะเอกสารที่ออกแล้วและยังไม่ถูกยกเลิก');
  checkVersion(d, version);
  if (d.correctionClass === 'T' && isFiscalChange(d, body)) {
    throw new MockError(422, 'doc.revise_not_allowed', 'การแก้ไขนี้กระทบภาษี ต้องทำผ่านแผนการแก้ไข (ยกเลิก/ออกใหม่/ใบลดหนี้)');
  }
  if (d.correctionClass === 'L' && blockingLocks(d).length) throw new MockError(409, 'doc.locked', 'เอกสารถูกล็อก แก้ไขไม่ได้');
  if (d.correctionClass !== 'T') { const m = missingOf(st, d.companyId, d.type, body); if (m.length) throw incomplete(m); }
  if (body.header.documentDate !== d.header.documentDate) dateGuards(st, d.companyId, body.header.documentDate); // a moved date follows the issue rules
  refusePartyChange(st, d, body);
  refuseNonPositive(st, d.companyId, d.type, body, d.id);
  refuseBelowSettled(st, d, body);
  refuseUnrevisablePurchase(st, d, body);
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
  const fin0 = isNote(d.type) ? withNoteVat(st, d.companyId, d.type, body, d.id) : body; // a revised vendor note: rule B again, the note itself not among its own predecessors
  const fin = { ...fin0, header: withClaimPeriod(st, d.companyId, d.type, fin0.header) }; // a bill is always filed in a claim period: the vendor invoice month unless one was chosen; a PCN keeps none
  const { allocations: _a, ...rest } = d; void _a;
  const totals = totalsOf(st, d.companyId, d.type, fin, d.id);
  const payout = payoutOf(st, d.companyId, { id: d.id, type: d.type, ...fin, totals });
  const reapprove = reviseNeedsApproval(st, d, payout, fin.allocations); // C1: more money than was approved needs an approver in the same command
  if (reapprove) {
    if (!opts?.approver) throw approvalOnRevise();
    refuseSelfApproval(st, { ...d, moneyBy: actor }, opts.approver); // the person making this change is now the one who set the money
  }
  const next: Stored = {
    ...rest, header: fin.header, lines: fin.lines, totals, party: partyOf(st, d.companyId, fin.header.partyId),
    revision: d.revision + 1, version: d.version + 1, ...(fin.allocations ? { allocations: fin.allocations } : {}), ...(fin.whtFrozen ? { whtFrozen: fin.whtFrozen } : {}),
    ...(moneyChanged(d, totals.total, fin) ? { moneyBy: actor } : {}),
    ...(reapprove ? { approval: { submittedBy: actor, submittedAt: stamp(), approvedBy: opts!.approver, approvedAt: stamp(), amount: payout } } : {}),
  };
  const marks = afterRevision(d); // a quotation's customer answer is void once it is revised
  if (marks) next.marks = marks; else delete next.marks;
  put(st, next);
  if (isNote(d.type)) { // the note's one adjusts link carries its total: a revised note moves the bill's outstanding with it
    st.links = st.links.map((l) => (l.active && l.kind === 'adjusts' && l.from === id ? { ...l, amount: next.totals.total } : l));
    recomputeSettlement(st, d.header.refDocId!);
  }
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
  if (d.type === 'PV') { syncWts(st, id, actor); settlePaidUpRecords(st, id, [...(d.allocations ?? []), ...(next.allocations ?? [])].map((a) => a.targetId)); } // changed WHT: the old certificates are cancelled and new ones issued; unchanged WHT keeps them (§7.3 L)
  const at = stamp();
  st.revisions.push({ docId: id, revision: next.revision, at, actor, reason, snapshot: publicDoc(getDoc(st, id)), diff: diffBody(d, fin) });
  logActivity(st, id, actor, 'revise', certNote(d, body) ?? reason);
  if (reapprove) { logActivity(st, id, opts!.approver!, 'approve', 'อนุมัติการแก้ไข'); logAudit(st, opts!.approver!, d.companyId, 'doc.approve', id, { amount: d.approval?.amount }, { amount: payout }); }
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
  const dated = old.type === 'TI' || old.type === 'RC' || isNote(old.type); // I9 / T5: a reissue keeps the date and the total
  if (dated) body = { ...body, header: { ...body.header, documentDate: old.header.documentDate, ...(isNote(old.type) ? { refDocId: old.header.refDocId } : {}) } }; // a note stays on its invoice
  body = keepNoteLines(old, body); // a reason-only change keeps the note's VAT even after a sibling was cancelled
  const missing = missingOf(st, old.companyId, old.type, body);
  if (missing.length) throw incomplete(missing);
  if (isNote(old.type)) { const np = noteProblem(st, old.companyId, old.type, body, old.id); if (np) throw np; }
  body = withWht(st, old.companyId, old.type, withNoteVat(st, old.companyId, old.type, body, old.id), old);
  const totals = totalsOf(st, old.companyId, old.type, body, old.id);
  if (approvalRequired(st, old.companyId, old.type, payoutOf(st, old.companyId, { id: old.id, type: old.type, ...body, totals }))) throw new MockError(422, 'approval.required', 'เอกสารประเภทนี้ต้องได้รับอนุมัติก่อนออก ออกใหม่โดยตรงไม่ได้ ให้ยกเลิกเอกสารเดิมแล้วสร้างฉบับร่างใหม่และส่งอนุมัติ'); // a reissue is an issue path too: the NEW total is judged (M1)
  if (dated && totals.total !== old.totals.total) {
    throw new MockError(422, 'doc.reissue_total_changed', 'ออกใหม่ต้องใช้ยอดเดิม ยอดต่างต้องใช้ใบลดหนี้/ใบเพิ่มหนี้');
  }
  const at = stamp();
  const created: Stored = {
    companyId: old.companyId, id: newId(st, old.type), type: old.type, number: allocate(st, old.companyId, old.type, body.header.documentDate),
    status: 'issued', correctionClass: old.correctionClass, revision: 0, version: 1, header: body.header,
    party: partyOf(st, old.companyId, body.header.partyId), lines: body.lines, totals, locks: [], createdBy: actor, issuedAt: at, replacesId: old.id,
    ...(hasOut(old.type) ? { outstanding: totals.total } : {}), ...(body.allocations ? { allocations: body.allocations } : {}), ...(body.whtFrozen ? { whtFrozen: body.whtFrozen } : {}),
  };
  const { outstanding: _o, ...oldRest } = old; void _o;
  put(st, { ...oldRest, status: 'replaced', replacedById: created.id, version: old.version + 1, cancel: { reasonCode: 'CORRECTION', reasonText: reason, at } });
  st.docs.push(created);
  if (hasSnapshot(created.type)) created.adjustSnapshot = old.adjustSnapshot ?? adjustSnapshot(st, getDoc(st, created.header.refDocId!), created); // a reissue keeps date and total (I9), so it keeps the values the customer holds
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
  if (SETTLES[targetType]?.includes(src.type) && CONVERSIONS[src.type]?.includes(targetType) && src.type === 'EX') { // EX -> PV: the voucher pays what the claim still owes (an allocation, no quantities); the settles link is made at the voucher's issue
    const out = balanceOf(st, src).out;
    if (out <= 0) throw new MockError(422, 'doc.nothing_to_pay', 'ใบเบิกนี้ไม่มียอดค้างจ่ายแล้ว');
    const d = insertDraft(st, src.companyId, targetType, { header: { partyId: src.header.partyId, documentDate: today(), ...(src.number ? { reference: src.number } : {}) }, lines: [],
      allocations: [{ targetId: src.id, targetType: src.type, amount: fromSatang(out) }] }, actor, opts?.id);
    logActivity(st, d.id, actor, 'create', `จ่ายตาม ${src.number}`);
    logAudit(st, actor, src.companyId, 'doc.convert', src.id, undefined, { target: d.id, type: targetType });
    return publicDoc(getDoc(st, d.id));
  }
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
