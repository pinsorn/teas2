import { LIVE } from '@/domain/doc-types';
import type { FilingForm, FilingHistoryItem, FilingModel } from '@/domain/filings';
import type { Actor, JournalEntryPreview, Lock } from '@/domain/types';
import { USER } from '../../fixtures/documents';
import type { MockState } from '../../store';
import { companyEntries } from '../ledger';
import { MockError, isPinned, logAudit, stamp, today, withFixedClock } from '../log';
import { fromSatang, toSatang } from '../money';
import { isClosed, monthLabelTh, refuseYearClosed } from '../periods';
import { resolveRole } from '../posting';
import { isFiledPeriod, openClaimMonth } from '../purchase-vat';
import { type DocLike, type Filing, type Pp30Doc, PERIOD, boxOf, chainStart, getPp30, pp30Boxes, pp30Docs, pp30Model, pp30Netting, pp30RowOf, pp36VatOf, prevMonth, requireVat, tie } from './pp30';
import { CIT_FORMS, YEAR, citBuild, citInvariants, citSnapshotModel, isCit } from './cit';
import { filingHref as filingHref0, paymentInvariants, paymentStateOf } from './payment';
import { PND_FORMS, type PndForm, formName, isPnd, pndAttachment, pndModel, pndRows, pndSnapshot, wantedWhtRows, whtKey, whtRowOfWt } from './pnd-wht';
import { lastDayOf, pp36Attachment, pp36Key, pp36Model, pp36RowOf, pp36Rows, pp36Snapshot, pp36Vat } from './pp36';

export { chainStart };
export type { Filing };
const fail = (status: number, code: string, title: string) => new MockError(status, code, title);
const sat = (m: string | undefined) => toSatang(m ?? '0.00');
const filingOf = (st: MockState, companyId: string, period: string, form: FilingForm = 'PP30') => st.filings.find((f) => f.companyId === companyId && f.form === form && f.period === period);
const TIES = ['outputGl', 'inputGl', 'outputRegister', 'inputRegister'].map((k) => `filing.tie.${k}`);
const EXIT = 'ออกใบลดหนี้ / ใบเพิ่มหนี้ในงวดถัดไป';
/** Ruling 2 (TX2): a voucher a ภ.ง.ด. / ภ.พ.36 took cannot be cancelled (so "cancel and reissue" is not a path); what works is a NEW voucher in the next open month for the part that was wrong. */
const WHT_EXIT = 'ออกใบสำคัญจ่ายใหม่ในงวดถัดไปสำหรับส่วนที่ต้องแก้ (ใบสำคัญจ่ายนี้ยกเลิกหรือออกใหม่ไม่ได้ เพราะยื่นแบบแล้ว)';
const isAnnex = (f: FilingForm) => f === 'PP36' || isPnd(f);
const hrefOf = filingHref0;
/** TX3a: the year forms name a fiscal year, the others a month. */
const periodTh = (form: FilingForm, period: string) => (isCit(form) ? `ปีบัญชี ${Number(period) + 543}` : `เดือน ${monthLabelTh(period)}`);
/** Which box states the tax of a form (the history's `net`). */
const NET_BOX: Partial<Record<FilingForm, string>> = { PP30: '11', PND2: 'tax', PND3: 'tax', PND53: 'tax', PND54: 'tax', PP36: 'vat', PND50: 'net', PND51: 'tax' };

const NOT_BUILT = () => fail(404, 'filing.not_available', 'ยังไม่มีแบบนี้ในระบบ');
/** The frozen snapshot of a finalized ภ.ง.ด. / ภ.พ.36 as the model reads it (ruling 1: never recomputed). */
const snapshotModel = (f: Filing): FilingModel => f.cit || f.pnd51 ? citSnapshotModel(f) : ({ form: f.form, period: f.period, status: 'finalized', boxes: f.boxes, tieOuts: f.tieOuts, blockers: [], warnings: [],
  attachment: f.wht ? pndAttachment(f.wht) : pp36Attachment(f.p36 ?? []), finalizedAt: f.finalizedAt, finalizedBy: f.finalizedBy, company: f.company, version: 1, dueDate: f.dueDate, exports: f.form === 'PP36' || f.form === 'PND54' ? ['pdf'] : ['rdprep-txt', 'pdf'] });

/** A form's filing for a period: the frozen snapshot once finalized (ruling 1: never recomputed), else the draft computed from the documents. */
export function getFiling(st: MockState, companyId: string, form: FilingForm, period: string): FilingModel {
  if (form === 'PP30') { requireVat(st, companyId); const m = getPp30(st, companyId, period), f = filingOf(st, companyId, period); return f ? { ...m, payment: paymentStateOf(st, f) } : m; }
  if (isCit(form)) { const f = filingOf(st, companyId, period, form); return f ? snapshotModel(f) : citBuild(st, companyId, form, period).model; } // TX3a: ภ.ง.ด.50 / 51, period = the fiscal year, no payment (ruling 8: no CIT journal)
  if (!isAnnex(form)) throw NOT_BUILT();
  if (!PERIOD.test(period)) throw fail(422, 'filing.bad_period', 'งวดต้องอยู่ในรูปแบบ ปปปป-ดด');
  const f = filingOf(st, companyId, period, form);
  if (f) return { ...snapshotModel(f), payment: paymentStateOf(st, f) };
  return form === 'PP36' ? pp36Model(st, companyId, period) : pndModel(st, companyId, form as PndForm, period);
}

/** Finalize (ยืนยันยื่นแบบ): one per company x form x period (I10); refused while a blocker stands and on a preview that went stale. Stores the boxes, the tie-outs and the exact list of documents with the figures each gave. */
export function finalizeFiling(st: MockState, companyId: string, form: FilingForm, period: string, version: number, actor: Actor, ack = false): FilingModel {
  if (form !== 'PP30' && !isAnnex(form) && !isCit(form)) throw NOT_BUILT();
  if (form === 'PP30') requireVat(st, companyId);
  if (!isCit(form) && !PERIOD.test(period)) throw fail(422, 'filing.bad_period', 'งวดต้องอยู่ในรูปแบบ ปปปป-ดด');
  const name = formName(form);
  if (filingOf(st, companyId, period, form)) throw fail(409, 'filing.already_finalized', `แบบ ${name} ${periodTh(form, period)} ยืนยันแล้ว`);
  const built = isCit(form) ? citBuild(st, companyId, form, period) : undefined;
  const m = built ? built.model : form === 'PP30' ? pp30Model(st, companyId, period) : form === 'PP36' ? pp36Model(st, companyId, period) : pndModel(st, companyId, form as PndForm, period);
  if (m.version !== version) throw fail(409, 'filing.stale', 'เอกสารในงวดนี้เปลี่ยนไปตั้งแต่ที่ดูตัวอย่าง โหลดใหม่แล้วตรวจอีกครั้ง');
  if (m.blockers.length) throw fail(422, 'filing.blocked', `ยืนยันแบบ ${name} ${periodTh(form, period)} ไม่ได้: ${m.blockers[0].labelTh}`);
  if (form === 'PP36' && !ack) throw fail(422, 'filing.ack_required', 'ต้องติ๊กรับทราบก่อนยืนยันยื่นแบบ ภ.พ.36'); // parity: the acknowledgement is mandatory
  const co = st.companies.find((c) => c.id === companyId)!;
  const prev = filingOf(st, companyId, prevMonth(period));
  let netting: JournalEntryPreview[] = [];
  if (form === 'PP30') { // TX2c D1: the month's VAT is closed into VAT payable / carried forward on the finalize day (today's date; the pinned seed day under withFixedClock)
    const date = isPinned() ? stamp().slice(0, 10) : today();
    netting = pp30Netting(st, companyId, period, m.boxes, date);
    if (netting.length && !isPinned()) {
      refuseYearClosed(st, companyId, date);
      if (isClosed(st, companyId, date)) throw fail(422, 'period.closed', `งวดบัญชี ${monthLabelTh(date.slice(0, 7))} ปิดแล้ว ยืนยันแบบ ภ.พ.30 ไม่ได้ (ระบบปิดภาษีขาย-ภาษีซื้อเข้าบัญชีภาษีค้างจ่ายวันที่ยืนยัน) ทางออก: เปิดงวดบัญชีอีกครั้ง`);
    }
  }
  const snap = built ? { docs: [], carryIn: '0.00', pp36: '0.00', ...(built.cit ? { cit: built.cit } : { pnd51: built.pnd51 }) }
    : form === 'PP30'
    ? { docs: pp30Docs(st, companyId, period), carryIn: prev ? prev.boxes.find((b) => b.code === '9')!.amount : '0.00', pp36: fromSatang(pp36VatOf(st, companyId, period)), journal: netting }
    : form === 'PP36' ? pp36Snapshot(st, companyId, period) : pndSnapshot(st, companyId, form as PndForm, period);
  const tieOuts = built ? m.tieOuts : form === 'PP36' ? [tie('filing.tie.pp36Gl', boxOf(m.boxes, 'vat'), pp36Gl(st, companyId, period, (snap as ReturnType<typeof pp36Snapshot>).journal ?? []))] : m.tieOuts;
  st.filings.push({ companyId, form, period, status: 'finalized', company: { taxId: co.taxId, branchCode: co.branchCode, legalNameTh: co.legalNameTh }, boxes: m.boxes, tieOuts, ...snap,
    finalizedAt: stamp(), finalizedBy: actor.name, dueDate: m.dueDate });
  logAudit(st, actor, companyId, 'filing.finalize', `${form} ${period}`, { status: 'draft' }, { status: 'finalized', net: boxOf(m.boxes, NET_BOX[form]!) });
  return getFiling(st, companyId, form, period);
}

/** m3: the ledger side of the ภ.พ.36 tie-out: the credit movement (credit - debit) of the ภ.พ.36 payable account in the payment month, over the whole ledger plus the entry this finalize is about to post. */
function pp36Gl(st: MockState, companyId: string, period: string, entry: JournalEntryPreview[]): number {
  const code = resolveRole(st, 'Pnd36VatPayable', { companyId, docType: 'PV' }).code;
  let n = 0;
  const paid = new Set(st.bankJournals.filter((j) => j.kind === 'tax').flatMap((j) => j.entries)); // TX2c: paying a ภ.พ.36 (Dr the payable, dated the month after) is not the month's VAT
  for (const e of [...companyEntries(st, companyId, false), ...entry]) if (e.date.startsWith(period) && !paid.has(e)) for (const l of e.lines) if (l.accountCode === code) n += sat(l.credit) - sat(l.debit);
  return n;
}

/** The company's finalized filings of a form, newest first. */
export function filingHistory(st: MockState, companyId: string, form: FilingForm): FilingHistoryItem[] {
  return st.filings.filter((f) => f.companyId === companyId && f.form === form).sort((a, b) => b.period.localeCompare(a.period))
    .map((f) => { const net = boxOf(f.boxes, NET_BOX[f.form]!), cit = isCit(f.form); // a ภ.ง.ด.50 'net' is signed (negative = overpaid)
      return { form: f.form, period: f.period, finalizedAt: f.finalizedAt, finalizedBy: f.finalizedBy, net: cit ? fromSatang(Math.abs(net)) : f.boxes.find((b) => b.code === NET_BOX[f.form])!.amount, overpaid: cit ? net < 0 : f.form === 'PP30' && boxOf(f.boxes, '9') > 0, ...(cit ? {} : paymentItem(st, f)) }; });
}

const paymentItem = (st: MockState, f: Filing) => { const p = paymentStateOf(st, f); return { payment: p.status, ...(p.paidOn ? { paidOn: p.paidOn } : {}) }; };

/** The file for RD Prep. [SP-R] "Format กลาง": the mock emits a pipe-delimited sample (H header, D rows, T totals), CRLF line ends; the golden strings are SP-R / SP2. A draft has no file: the file is what you file.
 *  ภ.ง.ด.54 and ภ.พ.36 are PDF only (parity A). */
export function exportFilingText(st: MockState, companyId: string, form: FilingForm, period: string): string {
  const m = getFiling(st, companyId, form, period);
  if (m.status !== 'finalized') throw fail(409, 'filing.not_finalized', 'ยืนยันแบบก่อนจึงจะสร้างไฟล์ได้');
  if (!m.exports.includes('rdprep-txt')) throw fail(404, 'filing.no_export', `${formName(form)} ไม่มีไฟล์สำหรับ RD Prep (พิมพ์แบบอย่างเดียว)`);
  const f = filingOf(st, companyId, period, form)!, co = f.company; // M2: who filed, as frozen at finalize
  const be = `${Number(period.slice(0, 4)) + 543}${period.slice(5, 7)}`;
  const head = `H|${form}|${co.taxId}|${co.branchCode}|${be}|${co.legalNameTh}`;
  if (f.wht) return [head, ...f.wht.map((r, i) => `D|${i + 1}|${r.tin}|${r.partyName}|${r.date}|${r.incomeType}|${r.income}|${r.tax}|${r.rate}|${r.condition}`), `T|${f.wht.length}|${m.boxes.find((b) => b.code === 'income')!.amount}|${m.boxes.find((b) => b.code === 'tax')!.amount}`, ''].join('\r\n');
  return [head, ...m.boxes.map((b) => `D|${b.code}|${b.amount}`), `T|${m.boxes.length}`, ''].join('\r\n');
}

// ---------------------------------------------------------------- the filing lock (rulings 2 and 3)

/** M1: the forms whose snapshot lists OUR documents, and how each is written. ภ.ง.ด. / ภ.พ.36 list vouchers and certificates and lock them under their own form. */
const LOCKING: Partial<Record<FilingForm, string>> = { PP30: 'ภ.พ.30', PND2: 'ภ.ง.ด.2', PND3: 'ภ.ง.ด.3', PND53: 'ภ.ง.ด.53', PND54: 'ภ.ง.ด.54', PP36: 'ภ.พ.36' };
/** Every finalized filing that took this document: a ภ.พ.30 row (live), a ภ.ง.ด. certificate row (the certificate itself, or the voucher that issued it), a ภ.พ.36 voucher row. */
const inFilings = (st: MockState, d: { id?: string; companyId: string }): Filing[] => (d.id
  ? st.filings.filter((f) => LOCKING[f.form] && f.companyId === d.companyId && ((f.form === 'PP30' && f.docs.some((x) => x.id === d.id && x.state === 'live')) || !!f.wht?.some((r) => r.id === d.id || r.pvId === d.id) || !!f.p36?.some((r) => r.id === d.id)))
  : []);
/** A live document that fed a finalized filing reads with the filing lock (derived from the snapshot's list, never stored). */
export function filingLock(st: MockState, d: { id?: string; companyId: string }): Lock | undefined {
  const f = inFilings(st, d)[0];
  return f ? { kind: 'filing', reason: `${LOCKING[f.form]} เดือน ${monthLabelTh(f.period)} ยื่นแล้ว`, exits: [isAnnex(f.form) ? WHT_EXIT : EXIT], href: hrefOf(f.form, f.period) } : undefined;
}
/** What a filing took from a document and would notice moving: the date, the bases and VAT by tax code, the claim period, the vendor invoice date and forfeit flag, and the party's TIN and branch. Notes and paper-only fields stay free. */
const took = (r: Pp30Doc) => JSON.stringify([r.date, r.base7, r.base0, r.baseEx, r.vat, r.claimPeriod ?? '', r.vendorDocDate ?? '', !!r.forfeit, r.tin ?? '', r.branch ?? '']);
/** The body a revision / a correction plan / an issue would give the document (the WHT it freezes included, so plan and revise judge the same figures). */
export type Next = { header: DocLike['header']; lines: DocLike['lines']; allocations?: DocLike['allocations']; whtFrozen?: DocLike['whtFrozen'] };
const locked = (f: Filing, next?: unknown) => fail(409, 'filing.locked', `${LOCKING[f.form]} เดือน ${monthLabelTh(f.period)} ยื่นแล้ว — ${next
  ? (isAnnex(f.form) ? 'แก้ไขยอด ภาษีหัก ณ ที่จ่าย ประเภทเงินได้ ฟอร์ม วันที่จ่าย หรือผู้รับเงินและเลขประจำตัวผู้เสียภาษี/สาขา/ที่อยู่ไม่ได้' : 'แก้ไขยอด ภาษี รหัสภาษี วันที่ งวดที่ขอคืนภาษี ผู้ขาย/ลูกค้า หรือเลขประจำตัวผู้เสียภาษี/สาขาไม่ได้') : 'ยกเลิกหรือออกใหม่ไม่ได้'} ทางออก: ${isAnnex(f.form) ? WHT_EXIT : EXIT}`);
const sameKeys = (a: string[], b: string[]) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

/** Ruling 2 / 3: a document that fed a finalized filing is not cancelled or reissued (no `next`), nor revised in anything the filing took (`next` = the body the revision would make;
 *  the header must already carry the derived claim period and forfeit flag, so a revise and a correction plan judge the same thing). The exit is the CN / DN in the next open month (ภ.พ.30), or a new voucher in the next open month (ภ.ง.ด. / ภ.พ.36). */
export function refuseFiled(st: MockState, d: DocLike, next?: Next): void {
  const fs = LIVE.includes(d.status) ? inFilings(st, d) : [];
  if (!fs.length) { if (next) refuseIntoFiled(st, { ...d, ...next }); return; } // not in a filing yet: it must not move INTO one either
  for (const f of fs) {
    if (!next) throw locked(f);
    if (f.form === 'PP30') { // M4: the party stays as filed (a revise keeps the stored snapshot); a later master edit moves nothing here
      if (next.header.partyId !== d.header.partyId) throw locked(f, next);
      const was = f.docs.find((x) => x.id === d.id)!, will = pp30RowOf(st, { ...d, ...next });
      if (!will || took(will) !== took(was)) throw locked(f, next);
    } else if (f.form === 'PP36') {
      const was = f.p36!.find((r) => r.id === d.id)!, will = pp36RowOf(st, { ...d, ...next });
      if (next.header.partyId !== d.header.partyId || !will || pp36Key(will) !== pp36Key(was)) throw locked(f, next);
    }
  }
  if (!next) return;
  if (d.type === 'PV' && !fs.some((f) => f.form === 'PP36')) refuseIntoPp36(st, { ...d, ...next }); // a voucher only a ภ.ง.ด. took must not gain a ภ.พ.36 entry in a filed month either
  const pnds = fs.filter((f) => f.wht);
  if (pnds.length) { // the vouchers' certificates in filed returns: the rows the revision would give must be exactly the rows the returns took
    if (d.type !== 'PV' || next.header.partyId !== d.header.partyId) throw locked(pnds[0], next);
    const was = st.filings.filter((f) => f.companyId === d.companyId && f.wht).flatMap((f) => f.wht!.filter((r) => r.pvId === d.id).map(whtKey));
    const will = wantedWhtRows(st, d, next).filter((r) => isFiledPeriod(st, d.companyId, r.date.slice(0, 7), r.form as FilingForm)).map(whtKey);
    if (!sameKeys(was, will)) throw locked(pnds[0], next);
  }
}

/** B1 (ruling): nothing enters a filed month. A TI / CN / DN is judged by its document month, a vendor document by the month it CLAIMS in (a PCN / EX: its document month; a PB / PDN: the period chosen, which
 *  defaults to the first unfiled month of its window - `withClaimPeriod` - so only an explicit filed period, or a window with no unfiled month left, reaches here). A vendor document that claims no VAT feeds no filing.
 *  TX2: a voucher is judged by the month of its payment date: a certificate in a form whose ภ.ง.ด. is finalized for that month, a `pnd36` line in a month whose ภ.พ.36 is finalized.
 *  \`d\` carries the header and lines it WOULD have (status live). Called from \`issue\` and, through \`refuseFiled\`, from revise and the correction plan. An additional return (ยื่นแบบเพิ่มเติม) is outside the system. */
export function refuseIntoFiled(st: MockState, d: DocLike): void {
  if (d.type === 'PV') {
    for (const r of wantedWhtRows(st, d, d)) if (isFiledPeriod(st, d.companyId, r.date.slice(0, 7), r.form as FilingForm)) throw filedMonth(r.form as FilingForm, r.date.slice(0, 7));
    refuseIntoPp36(st, d);
    return;
  }
  const r = pp30RowOf(st, d);
  if (!r || (r.kind === 'in' && sat(r.vat) === 0)) return;
  const period = r.kind === 'out' ? r.date.slice(0, 7) : r.claimPeriod!;
  if (!isFiledPeriod(st, d.companyId, period)) return;
  const bill = r.kind === 'in' && (d.type === 'PB' || d.type === 'PDN');
  const open = bill ? openClaimMonth(st, d.companyId, r.date, r.vendorDocDate) : undefined;
  const how = !bill ? '' : open ? `เลือกงวดที่ขอคืนภาษีซื้อเป็น ${monthLabelTh(open)} หรือ` : 'ไม่เหลืองวดที่ยังไม่ยื่นในกรอบ 6 เดือน (ม.82/3) ภาษีซื้อขอคืนไม่ได้ ให้';
  throw fail(409, 'filing.period_filed', `ภ.พ.30 เดือน ${monthLabelTh(period)} ยื่นแล้ว — ${how}ลงวันที่ในงวดที่ยังไม่ยื่น`);
}
/** A voucher with a `pnd36` line lands its ภ.พ.36 entry in its payment month: refused when that month's ภ.พ.36 or ภ.พ.30 is finalized (the entry would post into a filed month, H1). */
function refuseIntoPp36(st: MockState, d: DocLike): void {
  const p = pp36RowOf(st, d);
  if (!p) return;
  const m = p.date.slice(0, 7);
  if (isFiledPeriod(st, d.companyId, m, 'PP36')) throw filedMonth('PP36', m);
  if (isFiledPeriod(st, d.companyId, m)) throw filedMonth('PP30', m);
}
const filedMonth = (form: FilingForm, period: string) => fail(409, 'filing.period_filed', `${formName(form)} เดือน ${monthLabelTh(period)} ยื่นแล้ว — ลงวันที่จ่ายในงวดที่ยังไม่ยื่น`);

// ---------------------------------------------------------------- invariants (ruling 1)

/** Every finalized filing is what it froze: one per company x form x period; its boxes are exactly what its stored documents give; its tie-outs add up; its carry is the previous month's excess; every listed live document is live and still carries the
 *  figures the snapshot took (a cancelled row only for a document that is cancelled); no live document of the month (TI / CN / DN by document month, a vendor document that claims VAT by claim period) is missing from the snapshot (B1);
 *  the four tie-outs are all there and start from the stored boxes (M3); a row's number and party name are still what the document says (neither can change on an issued document, so a difference is a tamper). The paper fields
 *  (line description, vendor invoice number, EX invoice list: a vendor document is revised in place) stay outside the invariant: they are editable and the register keeps what was filed.
 *  TX2: a ภ.ง.ด. is its stored certificate rows (boxes = rows, every certificate live with the payee and figures it took, none of the month / form missing); a ภ.พ.36 is its stored voucher rows (boxes, VAT rounded once, every voucher live and giving
 *  the same base, none missing) and its journal (two balanced lines of the VAT, dated the payment month's last day, in the account of its claim status). */
export function filingInvariants(st: MockState): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const f of st.filings) {
    const w = `filing ${f.form} ${f.period} (${f.companyId})`;
    if (seen.has(`${f.companyId}|${f.form}|${f.period}`)) out.push(`${w}: finalized twice`);
    seen.add(`${f.companyId}|${f.form}|${f.period}`);
    for (const t of f.tieOuts) if (sat(t.left) - sat(t.right) + (t.reconciling ?? []).reduce((n, r) => n + sat(r.amount), 0) !== sat(t.diff)) out.push(`${w}: tie-out ${t.labelKey} diff ${t.diff} is not left - right + reconciling`);
    if (f.form === 'PP30') ppInvariants(st, f, w, out);
    else if (isCit(f.form)) citInvariants(st, f, w, out);
    else if (f.wht) pndInvariants(st, f, w, out);
    else pp36Invariants(st, f, w, out);
  }
  out.push(...paymentInvariants(st));
  return out;
}

function pndInvariants(st: MockState, f: Filing, w: string, out: string[]): void {
  const form = f.form as PndForm, rows = f.wht!;
  if (!(PND_FORMS as readonly string[]).includes(form)) { out.push(`${w}: not a withholding return`); return; }
  const payees = new Set(rows.map((r) => r.tin || r.partyId || r.partyName)).size, sum = (k: 'income' | 'tax') => rows.reduce((n, r) => n + sat(r[k]), 0);
  if (f.boxes.find((b) => b.code === 'payees')?.amount !== String(payees)) out.push(`${w}: the stored boxes are not what its stored certificates give (payees)`);
  if (boxOf(f.boxes, 'income') !== sum('income') || boxOf(f.boxes, 'tax') !== sum('tax')) out.push(`${w}: the stored boxes are not what its stored certificates give`);
  if (f.tieOuts.length !== 1 || f.tieOuts[0].labelKey !== 'filing.tie.pndGl') out.push(`${w}: tie-out filing.tie.pndGl is missing`);
  else if (sat(f.tieOuts[0].left) !== boxOf(f.boxes, 'tax')) out.push(`${w}: tie-out filing.tie.pndGl left ${f.tieOuts[0].left} is not the stored box`);
  const listed = new Set(rows.map((r) => r.id));
  for (const r of rows) {
    if (r.form !== form || !r.date.startsWith(f.period)) out.push(`${w}: ${r.id} is not a ${form} certificate of ${f.period}`);
    const wt = st.docs.find((x) => x.id === r.id && x.companyId === f.companyId);
    if (!wt) { out.push(`${w}: certificate ${r.id} is gone`); continue; }
    const now = LIVE.includes(wt.status) ? whtRowOfWt(st, wt) : undefined;
    if (!now) out.push(`${w}: ${r.id} is listed live but is ${wt.status}`);
    else if (whtKey(now) !== whtKey(r) || now.number !== r.number || now.pvId !== r.pvId) out.push(`${w}: ${r.id} no longer carries the figures the filing took`);
    else for (const k of ['partyName', 'rate', 'nameTh', 'entityKind'] as const) if (now[k] !== r[k]) out.push(`${w}: ${r.id} ${k} "${r[k]}" differs from the document "${now[k]}"`); // m1: printed in the attachment / file; the WT keeps its own party snapshot and the voucher its frozen WHT
  }
  for (const wt of st.docs) if (wt.companyId === f.companyId && wt.type === 'WT' && wt.header.whtForm === form && wt.header.documentDate.startsWith(f.period) && LIVE.includes(wt.status) && !listed.has(wt.id)) out.push(`${w}: ${wt.id} is missing from the snapshot`);
}

function pp36Invariants(st: MockState, f: Filing, w: string, out: string[]): void {
  const rows = f.p36 ?? [], vat = pp36Vat(rows), base = rows.reduce((n, r) => n + sat(r.base), 0);
  if (boxOf(f.boxes, 'base') !== base || boxOf(f.boxes, 'vat') !== vat) out.push(`${w}: the stored boxes are not what its stored vouchers give`);
  const lines = (f.journal ?? []).flatMap((e) => e.lines), e = f.journal?.[0];
  if (vat === 0 ? (f.journal ?? []).length !== 0 : (f.journal ?? []).length !== 1 || !e || e.date !== lastDayOf(f.period) || lines.length !== 2 || sat(lines[0].debit) !== vat || sat(lines[1].credit) !== vat || sat(lines[0].credit) !== 0 || sat(lines[1].debit) !== 0) {
    out.push(`${w}: its journal is not the one entry of ${fromSatang(vat)} dated ${lastDayOf(f.period)}`);
  }
  if (e && lines[0].accountCode !== resolveRole(st, f.claims ? 'InputVat' : 'InputVatUnclaimed', { companyId: f.companyId, docType: 'PV' }).code) out.push(`${w}: its debit is not in the account its claim status says`);
  if (f.tieOuts.length !== 1 || f.tieOuts[0].labelKey !== 'filing.tie.pp36Gl' || sat(f.tieOuts[0].left) !== vat) out.push(`${w}: tie-out filing.tie.pp36Gl is missing or not the stored VAT`);
  const listed = new Set(rows.map((r) => r.id));
  for (const r of rows) {
    const d = st.docs.find((x) => x.id === r.id && x.companyId === f.companyId);
    if (!d || !LIVE.includes(d.status)) { out.push(`${w}: voucher ${r.id} is gone or no longer live`); continue; }
    const now = pp36RowOf(st, d);
    if (!now || pp36Key(now) !== pp36Key(r) || now.number !== r.number) out.push(`${w}: ${r.id} no longer carries the figures the filing took`);
    else if (now.partyName !== r.partyName) out.push(`${w}: ${r.id} partyName "${r.partyName}" differs from the document "${now.partyName}"`); // m1
  }
  for (const d of st.docs) if (d.companyId === f.companyId && d.type === 'PV' && d.header.documentDate.startsWith(f.period) && pp36RowOf(st, d) && !listed.has(d.id)) out.push(`${w}: ${d.id} is missing from the snapshot`);
}

function ppInvariants(st: MockState, f: Filing, w: string, out: string[]): void {
  if (!st.companies.find((c) => c.id === f.companyId)?.vatRegistered) out.push(`${w}: the company is not VAT-registered`);
  if (JSON.stringify(pp30Boxes(f.docs, sat(f.carryIn), sat(f.pp36), f.period)) !== JSON.stringify(f.boxes)) out.push(`${w}: the stored boxes are not what its stored documents give`);
  for (const k of TIES) { // M3: none deleted, and each starts from the stored box (output: 5; input: 7 less the self-assessed ภ.พ.36 part)
    const t = f.tieOuts.find((x) => x.labelKey === k);
    if (!t) out.push(`${w}: tie-out ${k} is missing`);
    else if (sat(t.left) !== (k.includes('output') ? boxOf(f.boxes, '5') : boxOf(f.boxes, '7') - sat(f.pp36))) out.push(`${w}: tie-out ${k} left ${t.left} is not the stored box`);
  }
  { // TX2c 2.4: its netting entry is exactly the one its stored boxes give, posted after the month ended
    const j = f.journal ?? [], want = pp30Netting(st, f.companyId, f.period, f.boxes, j[0]?.date ?? '');
    const proj = (e: JournalEntryPreview) => JSON.stringify(e.lines.map((l) => [l.accountCode, l.debit, l.credit]));
    const ok = want.length === 0 ? j.length === 0 : j.length === 1 && j[0].kind === 'original' && j[0].date.slice(0, 7) > f.period && proj(j[0]) === proj(want[0]);
    if (!ok) out.push(`${w}: its netting entry is not the one its boxes give`);
  }
  const listed = new Set(f.docs.map((r) => r.id));
  for (const r of pp30Docs(st, f.companyId, f.period)) if (r.state === 'live' && !listed.has(r.id)) out.push(`${w}: ${r.id} is missing from the snapshot`); // B1
  const prev = filingOf(st, f.companyId, prevMonth(f.period));
  if (sat(f.carryIn) !== (prev ? boxOf(prev.boxes, '9') : 0)) out.push(`${w}: overpaid brought forward ${f.carryIn} is not the previous month's excess`);
  for (const r of f.docs) {
    const d = st.docs.find((x) => x.id === r.id && x.companyId === f.companyId);
    if (!d) { out.push(`${w}: document ${r.id} is gone`); continue; }
    const paper = pp30RowOf(st, d);
    if (paper) for (const k of ['number', 'partyName'] as const) if (paper[k] !== r[k]) out.push(`${w}: ${r.id} ${k} "${r[k] ?? ''}" differs from the document "${paper[k] ?? ''}"`); // M3
    if (r.state === 'cancelled') { if (d.status !== 'cancelled' && d.status !== 'replaced') out.push(`${w}: ${r.id} is listed as cancelled but is ${d.status}`); continue; }
    if (!LIVE.includes(d.status)) { out.push(`${w}: ${r.id} is listed live but is ${d.status}`); continue; }
    const now = pp30RowOf(st, d);
    if (!now || took(now) !== took(r)) out.push(`${w}: ${r.id} no longer carries the figures the filing took`);
  }
}

/** D-23: the finalized months of the seed go through the same command a user's click does, as of the day each was filed (the day after the due date's month starts; the 7th for a ภ.ง.ด., the 14th for the ภ.พ.30). The ภ.พ.30 chain starts at 2026-07, the ภ.ง.ด.3 / 53 chain at 2026-08. */
export function seedFilings(st: MockState): void {
  for (const [period, filed] of [['2026-07', '2026-08-14'], ['2026-08', '2026-09-14']]) {
    withFixedClock(`${filed}T10:00:00+07:00`, () => finalizeFiling(st, 'co-vat', 'PP30', period, pp30Model(st, 'co-vat', period).version, USER));
  }
  for (const [period, filed] of [['2026-08', '2026-09-07'], ['2026-09', '2026-10-07']]) {
    for (const form of ['PND3', 'PND53'] as const) withFixedClock(`${filed}T10:00:00+07:00`, () => finalizeFiling(st, 'co-vat', form, period, pndModel(st, 'co-vat', form, period).version, USER));
  }
}

/** Ruling 5 (TX2) / m2: the returns of a month that are owed and not finalized, for the period-close checklist. One rule for every form: a month is owed from that form's chain start (its first finalized period); a form never finalized counts from the
 *  company's earliest finalized filing of ANY form; a company with no finalized filing owes nothing. The ภ.พ.30 is owed in every such month (TX1); a ภ.ง.ด. or the ภ.พ.36 only when the month has certificates / vouchers for it. */
export function unfiledForms(st: MockState, companyId: string, month: string): FilingForm[] {
  const out: FilingForm[] = [];
  const mine = st.filings.filter((f) => f.companyId === companyId).map((f) => f.period).sort();
  const owed = (f: FilingForm, has: boolean) => { const s = chainStart(st, companyId, f) ?? mine[0]; if (has && s !== undefined && month >= s && !filingOf(st, companyId, month, f)) out.push(f); };
  owed('PP30', !!st.companies.find((c) => c.id === companyId)?.vatRegistered);
  for (const f of PND_FORMS) owed(f, pndRows(st, companyId, f, month).length > 0);
  owed('PP36', pp36Rows(st, companyId, month).length > 0);
  return out;
}
export const filingHref = hrefOf;
export { CIT_FORMS, YEAR };
