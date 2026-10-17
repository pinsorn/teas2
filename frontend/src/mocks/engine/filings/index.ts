import { LIVE } from '@/domain/doc-types';
import type { FilingForm, FilingHistoryItem, FilingModel } from '@/domain/filings';
import type { Actor, Lock } from '@/domain/types';
import { USER } from '../../fixtures/documents';
import type { MockState } from '../../store';
import { MockError, logAudit, stamp, withFixedClock } from '../log';
import { fromSatang, toSatang } from '../money';
import { monthLabelTh } from '../periods';
import { isFiledPeriod, openClaimMonth } from '../purchase-vat';
import { type DocLike, type Filing, type Pp30Doc, PERIOD, boxOf, chainStart, dueDateOf, getPp30, pp30Boxes, pp30Docs, pp30Model, pp30RowOf, pp36VatOf, prevMonth, requireVat } from './pp30';

export { chainStart };
export type { Filing };
const fail = (status: number, code: string, title: string) => new MockError(status, code, title);
const sat = (m: string | undefined) => toSatang(m ?? '0.00');
const filingOf = (st: MockState, companyId: string, period: string) => st.filings.find((f) => f.companyId === companyId && f.form === 'PP30' && f.period === period);
const TIES = ['outputGl', 'inputGl', 'outputRegister', 'inputRegister'].map((k) => `filing.tie.${k}`);
const EXIT = 'ออกใบลดหนี้ / ใบเพิ่มหนี้ในงวดถัดไป';

/** A form's filing for a period: the frozen snapshot once finalized (ruling 1: never recomputed), else the draft computed from the documents. Only the ภ.พ.30 exists in TX1. */
export function getFiling(st: MockState, companyId: string, form: FilingForm, period: string): FilingModel {
  if (form !== 'PP30') throw fail(404, 'filing.not_available', 'ยังไม่มีแบบนี้ในระบบ');
  requireVat(st, companyId);
  return getPp30(st, companyId, period);
}

/** Finalize (ยืนยันยื่นแบบ): one per company x form x period (I10); refused while a blocker stands and on a preview that went stale. Stores the boxes, the tie-outs and the exact list of documents with the figures each gave. */
export function finalizeFiling(st: MockState, companyId: string, form: FilingForm, period: string, version: number, actor: Actor): FilingModel {
  if (form !== 'PP30') throw fail(404, 'filing.not_available', 'ยังไม่มีแบบนี้ในระบบ');
  requireVat(st, companyId);
  if (!PERIOD.test(period)) throw fail(422, 'filing.bad_period', 'งวดต้องอยู่ในรูปแบบ ปปปป-ดด');
  if (filingOf(st, companyId, period)) throw fail(409, 'filing.already_finalized', `แบบ ภ.พ.30 เดือน ${monthLabelTh(period)} ยืนยันแล้ว`);
  const m = pp30Model(st, companyId, period);
  if (m.version !== version) throw fail(409, 'filing.stale', 'เอกสารในงวดนี้เปลี่ยนไปตั้งแต่ที่ดูตัวอย่าง โหลดใหม่แล้วตรวจอีกครั้ง');
  if (m.blockers.length) throw fail(422, 'filing.blocked', `ยืนยันแบบ ภ.พ.30 เดือน ${monthLabelTh(period)} ไม่ได้: ${m.blockers[0].labelTh}`);
  const prev = filingOf(st, companyId, prevMonth(period)), co = st.companies.find((c) => c.id === companyId)!;
  st.filings.push({ companyId, form, period, status: 'finalized', company: { taxId: co.taxId, branchCode: co.branchCode, legalNameTh: co.legalNameTh }, boxes: m.boxes, tieOuts: m.tieOuts, docs: pp30Docs(st, companyId, period), carryIn: prev ? prev.boxes.find((b) => b.code === '9')!.amount : '0.00',
    pp36: fromSatang(pp36VatOf(st, companyId, period)), finalizedAt: stamp(), finalizedBy: actor.name, dueDate: dueDateOf(period) });
  logAudit(st, actor, companyId, 'filing.finalize', `${form} ${period}`, { status: 'draft' }, { status: 'finalized', net: boxOf(m.boxes, '11') });
  return getFiling(st, companyId, form, period);
}

/** The company's finalized filings of a form, newest first. */
export function filingHistory(st: MockState, companyId: string, form: FilingForm): FilingHistoryItem[] {
  return st.filings.filter((f) => f.companyId === companyId && f.form === form).sort((a, b) => b.period.localeCompare(a.period))
    .map((f) => ({ form: f.form, period: f.period, finalizedAt: f.finalizedAt, finalizedBy: f.finalizedBy, net: f.boxes.find((b) => b.code === '11')!.amount, overpaid: boxOf(f.boxes, '9') > 0 }));
}

/** The file for RD Prep. [SP-R] "Format กลาง": the mock emits a pipe-delimited sample (H header, one D per box, T count), CRLF line ends; the golden strings are SP-R / SP2. A draft has no file: the file is what you file. */
export function exportFilingText(st: MockState, companyId: string, form: FilingForm, period: string): string {
  const m = getFiling(st, companyId, form, period);
  if (m.status !== 'finalized') throw fail(409, 'filing.not_finalized', 'ยืนยันแบบก่อนจึงจะสร้างไฟล์ได้');
  const co = filingOf(st, companyId, period)!.company; // M2: who filed, as frozen at finalize
  const be = `${Number(period.slice(0, 4)) + 543}${period.slice(5, 7)}`;
  return [`H|${form}|${co.taxId}|${co.branchCode}|${be}|${co.legalNameTh}`, ...m.boxes.map((b) => `D|${b.code}|${b.amount}`), `T|${m.boxes.length}`, ''].join('\r\n');
}

// ---------------------------------------------------------------- the filing lock (rulings 2 and 3)

/** M1: the forms whose snapshot lists OUR documents (TX2 adds ภ.พ.36 / ภ.ง.ด., which list vouchers and lock them under their own form), and how each is written. */
const LOCKING: Partial<Record<FilingForm, string>> = { PP30: 'ภ.พ.30' };
const inFiling = (st: MockState, d: { id?: string; companyId: string }) => (d.id ? st.filings.find((f) => LOCKING[f.form] && f.companyId === d.companyId && f.docs.some((x) => x.id === d.id && x.state === 'live')) : undefined);
/** A live document that fed a finalized ภ.พ.30 reads with the filing lock (derived from the snapshot's list, never stored). */
export function filingLock(st: MockState, d: { id?: string; companyId: string }): Lock | undefined {
  const f = inFiling(st, d);
  return f ? { kind: 'filing', reason: `${LOCKING[f.form]} เดือน ${monthLabelTh(f.period)} ยื่นแล้ว`, exits: [EXIT], href: `/tax/vat?period=${f.period}` } : undefined;
}
/** What a filing took from a document and would notice moving: the date, the bases and VAT by tax code, the claim period, the vendor invoice date and forfeit flag, and the party's TIN and branch. Notes and paper-only fields stay free. */
const took = (r: Pp30Doc) => JSON.stringify([r.date, r.base7, r.base0, r.baseEx, r.vat, r.claimPeriod ?? '', r.vendorDocDate ?? '', !!r.forfeit, r.tin ?? '', r.branch ?? '']);

/** Ruling 2 / 3: a document that fed a finalized filing is not cancelled or reissued (no `next`), nor revised in anything the filing took (`next` = the header and lines the revision would make;
 *  the header must already carry the derived claim period and forfeit flag, so a revise and a correction plan judge the same thing). The exit is the CN / DN in the next open month. */
export function refuseFiled(st: MockState, d: DocLike, next?: { header: DocLike['header']; lines: DocLike['lines'] }): void {
  const f = LIVE.includes(d.status) ? inFiling(st, d) : undefined;
  if (!f) { if (next) refuseIntoFiled(st, { ...d, header: next.header, lines: next.lines }); return; } // not in a filing yet: it must not move INTO one either
  if (next && next.header.partyId === d.header.partyId) { // M4: the party stays as filed (a revise keeps the stored snapshot); a later master edit moves nothing here
    const was = f.docs.find((x) => x.id === d.id)!, will = pp30RowOf(st, { ...d, header: next.header, lines: next.lines });
    if (will && took(will) === took(was)) return;
  }
  throw fail(409, 'filing.locked', `${LOCKING[f.form]} เดือน ${monthLabelTh(f.period)} ยื่นแล้ว — ${next ? 'แก้ไขยอด ภาษี รหัสภาษี วันที่ งวดที่ขอคืนภาษี ผู้ขาย/ลูกค้า หรือเลขประจำตัวผู้เสียภาษี/สาขาไม่ได้' : 'ยกเลิกหรือออกใหม่ไม่ได้'} ทางออก: ${EXIT}`);
}

/** B1 (ruling): nothing enters a filed month. A TI / CN / DN is judged by its document month, a vendor document by the month it CLAIMS in (a PCN / EX: its document month; a PB / PDN: the period chosen, which
 *  defaults to the first unfiled month of its window - `withClaimPeriod` - so only an explicit filed period, or a window with no unfiled month left, reaches here). A vendor document that claims no VAT feeds no filing.
 *  `d` carries the header and lines it WOULD have (status live). Called from `issue` and, through `refuseFiled`, from revise and the correction plan. An additional return (ยื่นแบบเพิ่มเติม) is outside the system. */
export function refuseIntoFiled(st: MockState, d: DocLike): void {
  const r = pp30RowOf(st, d);
  if (!r || (r.kind === 'in' && sat(r.vat) === 0)) return;
  const period = r.kind === 'out' ? r.date.slice(0, 7) : r.claimPeriod!;
  if (!isFiledPeriod(st, d.companyId, period)) return;
  const bill = r.kind === 'in' && (d.type === 'PB' || d.type === 'PDN');
  const open = bill ? openClaimMonth(st, d.companyId, r.date, r.vendorDocDate) : undefined;
  const how = !bill ? '' : open ? `เลือกงวดที่ขอคืนภาษีซื้อเป็น ${monthLabelTh(open)} หรือ` : 'ไม่เหลืองวดที่ยังไม่ยื่นในกรอบ 6 เดือน (ม.82/3) ภาษีซื้อขอคืนไม่ได้ ให้';
  throw fail(409, 'filing.period_filed', `ภ.พ.30 เดือน ${monthLabelTh(period)} ยื่นแล้ว — ${how}ลงวันที่ในงวดที่ยังไม่ยื่น`);
}

// ---------------------------------------------------------------- invariants (ruling 1)

/** Every finalized filing is what it froze: one per company x form x period; its boxes are exactly what its stored documents give; its tie-outs add up; its carry is the previous month's excess; every listed live document is live and still carries the
 *  figures the snapshot took (a cancelled row only for a document that is cancelled); no live document of the month (TI / CN / DN by document month, a vendor document that claims VAT by claim period) is missing from the snapshot (B1);
 *  the four tie-outs are all there and start from the stored boxes (M3); a row's number and party name are still what the document says (neither can change on an issued document, so a difference is a tamper). The paper fields
 *  (line description, vendor invoice number, EX invoice list: a vendor document is revised in place) stay outside the invariant: they are editable and the register keeps what was filed. */
export function filingInvariants(st: MockState): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const f of st.filings) {
    const w = `filing ${f.form} ${f.period} (${f.companyId})`;
    if (seen.has(`${f.companyId}|${f.form}|${f.period}`)) out.push(`${w}: finalized twice`);
    seen.add(`${f.companyId}|${f.form}|${f.period}`);
    if (!st.companies.find((c) => c.id === f.companyId)?.vatRegistered) out.push(`${w}: the company is not VAT-registered`);
    if (JSON.stringify(pp30Boxes(f.docs, sat(f.carryIn), sat(f.pp36), f.period)) !== JSON.stringify(f.boxes)) out.push(`${w}: the stored boxes are not what its stored documents give`);
    for (const t of f.tieOuts) if (sat(t.left) - sat(t.right) !== sat(t.diff)) out.push(`${w}: tie-out ${t.labelKey} diff ${t.diff} is not left - right`);
    for (const k of TIES) { // M3: none deleted, and each starts from the stored box (output: 5; input: 7 less the self-assessed ภ.พ.36 part)
      const t = f.tieOuts.find((x) => x.labelKey === k);
      if (!t) out.push(`${w}: tie-out ${k} is missing`);
      else if (sat(t.left) !== (k.includes('output') ? boxOf(f.boxes, '5') : boxOf(f.boxes, '7') - sat(f.pp36))) out.push(`${w}: tie-out ${k} left ${t.left} is not the stored box`);
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
  return out;
}

/** D-23: the finalized months of the seed go through the same command a user's click does, as of the day each was filed (the 14th of the next month). The chain starts at 2026-07. */
export function seedFilings(st: MockState): void {
  for (const [period, filed] of [['2026-07', '2026-08-14'], ['2026-08', '2026-09-14']]) {
    withFixedClock(`${filed}T10:00:00+07:00`, () => finalizeFiling(st, 'co-vat', 'PP30', period, pp30Model(st, 'co-vat', period).version, USER));
  }
}
