import { inputVatExpired } from '@/domain/claim-window';
import type { DocHeader, DocLine, DocType } from '@/domain/types';
import { EXPENSE_CATEGORIES, type ExpenseCategory } from '../fixtures/expense-categories';
import type { MockState } from '../store';
import { MockError } from './log';
import { RATE_BP, vatOf } from './vat';

/** Input VAT rules of the vendor documents (PB, and the notes PCN / PDN that adjust one). [SP-R] - the statute references are the cited sections of the Revenue Code. */
export const isVendorBill = (t: DocType): boolean => t === 'PB' || t === 'PCN' || t === 'PDN';

/** The expense category of a purchase line: the code STORED on the line (C1). A posted line never reads the item master; `snapshotCategories` copies the item's category onto the line at save / revise / issue. */
export const categoryOf = (_st: MockState, _companyId: string, l: DocLine): ExpenseCategory | undefined => EXPENSE_CATEGORIES.find((c) => c.code === l.expenseCategory);

/** C1: a line with no category of its own takes its picked item's NOW and keeps it (idempotent: a line that has one is left alone). */
export const snapshotCategories = (st: MockState, companyId: string, lines: DocLine[]): DocLine[] =>
  lines.map((l) => {
    if (l.expenseCategory) return l;
    const code = st.items.find((i) => i.id === l.itemId && i.companyId === companyId)?.expenseCategory;
    return code ? { ...l, expenseCategory: code } : l;
  });

/** C1 (WHT): a PB line with no WHT type of its own takes its picked item's NOW and keeps it, so a later edit of the item master never moves what a voucher withholds (the same pattern as the category). */
export const snapshotWhtTypes = (st: MockState, companyId: string, lines: DocLine[]): DocLine[] =>
  lines.map((l) => {
    if (l.whtTypeCode !== undefined) return l; // '' = cleared on purpose: the item master does not refill it
    const code = st.items.find((i) => i.id === l.itemId && i.companyId === companyId)?.whtTypeCode;
    return code ? { ...l, whtTypeCode: code } : l;
  });

/** ม.82/5 and ม.82/3: input VAT is claimed only by a VAT-registered company, and not on a category whose VAT cannot be claimed (e.g. entertainment), nor on a document whose claim window
 *  had already expired when it was recorded (`inputVatForfeited`). Everything else is cost (`InputVatUnclaimed`, or part of the asset on a capex line - TAS 16): the VAT on a vendor's
 *  tax invoice still exists, it is part of what the purchase cost (A.4). */
export const isRecoverable = (st: MockState, companyId: string, l: DocLine, forfeited?: boolean): boolean => vatOf(st, companyId) && !forfeited && categoryOf(st, companyId, l)?.recoverableVat !== false;

const YM = /^(\d{4})-(0[1-9]|1[0-2])$/;
const monthIndex = (ym: string): number => { const m = YM.exec(ym)!; return Number(m[1]) * 12 + Number(m[2]) - 1; };
/** The claim period a document is filed in: a PB / PDN the one chosen, else the month it is recorded in (D); a PCN always the month of its document date (I2). */
export const claimPeriodOf = (type: DocType, h: Pick<DocHeader, 'claimPeriod' | 'documentDate'>): string => (type === 'PCN' ? undefined : h.claimPeriod) ?? h.documentDate.slice(0, 7);
/** R1-I1 / ม.82/3: the period P is D .. V+6, V = the month of the vendor's tax invoice (else the document), D = the document month - never before D (a month already filed) [SP-R]. */
export const claimWindowOk = (documentDate: string, vendorDocDate: string | undefined, period: string): boolean => {
  const v = (vendorDocDate || documentDate).slice(0, 7);
  if (!YM.test(period) || !YM.test(documentDate.slice(0, 7)) || !YM.test(v)) return false;
  return monthIndex(period) >= monthIndex(documentDate.slice(0, 7)) && monthIndex(period) <= monthIndex(v) + 6;
};

/** R1-I1: is this document's input VAT forfeited (cost, never claimed)? A VAT company's PB / PDN recorded after the window of its own vendor invoice closed; a PCN follows the bill it credits
 *  (it gives back exactly what the bill claimed: nothing). Derived by the server, never taken from the client. */
export function forfeitedOf(st: MockState, companyId: string, type: DocType, h: DocHeader): boolean {
  if (!isVendorBill(type) || !vatOf(st, companyId)) return false;
  if (type === 'PCN') return !!st.docs.find((d) => d.id === h.refDocId && d.companyId === companyId && d.type === 'PB')?.header.inputVatForfeited;
  return !!h.documentDate && inputVatExpired(h.documentDate, h.vendorDocDate);
}

/** The header with the forfeit flag derived (a client-sent one is dropped) and no claim period on a forfeited document. */
export function withForfeit(st: MockState, companyId: string, type: DocType, h: DocHeader): DocHeader {
  if (!isVendorBill(type)) return h;
  const { inputVatForfeited: _f, ...rest } = h; void _f;
  if (!forfeitedOf(st, companyId, type, h)) return rest;
  const { claimPeriod: _c, ...kept } = rest; void _c;
  return { ...kept, inputVatForfeited: true };
}

/** The header as stored at issue / revise: forfeit derived; a VAT company's PB / PDN is filed in a claim period (the month it is recorded in unless chosen); a PCN keeps none, its period
 *  is its document month (a non-VAT company claims nothing). */
export const withClaimPeriod = (st: MockState, companyId: string, type: DocType, h0: DocHeader): DocHeader => {
  const h = withForfeit(st, companyId, type, h0);
  if (!isVendorBill(type) || !vatOf(st, companyId) || !h.documentDate) return h;
  if (type === 'PCN') { const { claimPeriod: _c, ...rest } = h; void _c; return rest; }
  return h.claimPeriod || h.inputVatForfeited ? h : { ...h, claimPeriod: claimPeriodOf(type, h) };
};

/** M2 / R1-M2: a draft carries no vendor VAT status (the party master is read when it is checked); a client-sent value is dropped, and an empty `vendorDocDate` means absent (R1-M3).
 *  An issued document keeps the status it was issued with (`prev`) while its vendor stays the same. */
export function withVendorStatus(_st: MockState, _companyId: string, type: DocType, h: DocHeader, prev?: DocHeader): DocHeader {
  if (!isVendorBill(type)) return h;
  const { vendorVatRegistered: _v, vendorDocDate, ...rest } = h; void _v;
  const kept = prev && prev.partyId === h.partyId ? prev.vendorVatRegistered : undefined;
  return { ...rest, ...(vendorDocDate ? { vendorDocDate } : {}), ...(kept !== undefined ? { vendorVatRegistered: kept } : {}) };
}

/** R1-M1 / R1-M2: the vendor's VAT status is recorded AT ISSUE (a draft issued later takes it afresh). A PB / PDN reads the party master as it is now; a PCN inherits the bill's (it gives the
 *  bill's VAT back, whatever the vendor is now). */
export function issueVendorStatus(st: MockState, companyId: string, type: DocType, h: DocHeader): DocHeader {
  if (!isVendorBill(type)) return h;
  const bill = type === 'PCN' ? st.docs.find((d) => d.id === h.refDocId && d.companyId === companyId && d.type === 'PB') : undefined;
  const status = bill?.header.vendorVatRegistered ?? st.parties.find((p) => p.id === h.partyId && p.companyId === companyId)?.vatRegistered;
  const { vendorVatRegistered: _v, ...rest } = h; void _v;
  return status === undefined ? rest : { ...rest, vendorVatRegistered: status };
}

/** Every command-time input VAT rule of a PB / PCN / PDN, first violation wins (undefined = fine): the vendor can only charge VAT when registered (ม.82/5, judged on the status recorded
 *  with the document, else the party master now), the category exists, the vendor invoice is not dated after the bill, the claim period is inside D .. V+6 (R1-I1; an expired window is not
 *  refused, the VAT is forfeited) - and a PCN has none (I2). Judged on the TAX CODE, not on the computed VAT, so a zero-priced line cannot slip through. */
export function purchaseProblem(st: MockState, companyId: string, type: DocType, body: { header: DocHeader; lines: DocLine[] }): MockError | undefined {
  if (!isVendorBill(type)) return undefined;
  const h = body.header;
  const vendor = st.parties.find((p) => p.id === h.partyId && p.companyId === companyId);
  const registered = h.vendorVatRegistered ?? vendor?.vatRegistered;
  if (vendor && registered === false && body.lines.some((l) => RATE_BP[l.taxCode] > 0n)) {
    return new MockError(422, 'pb.vendor_not_vat_registered', `ผู้ขาย “${vendor.name}” ไม่ได้จดทะเบียนภาษีมูลค่าเพิ่ม จึงมีภาษีซื้อไม่ได้ (ม.82/5) ให้เลือกรหัสภาษี “ไม่มีภาษี” ในรายการ`);
  }
  for (const l of body.lines) {
    if (l.expenseCategory && !EXPENSE_CATEGORIES.some((c) => c.code === l.expenseCategory)) {
      return new MockError(422, 'pb.unknown_category', `รายการ “${l.description}” ใช้หมวดค่าใช้จ่าย “${l.expenseCategory}” ที่ไม่มีในระบบ`);
    }
  }
  if (type !== 'PCN' && h.vendorDocDate && (!/^\d{4}-\d{2}-\d{2}$/.test(h.vendorDocDate) || h.vendorDocDate > h.documentDate)) {
    return new MockError(422, 'pb.vendor_invoice_after_document', `วันที่ใบกำกับภาษีของผู้ขาย (${h.vendorDocDate}) ต้องไม่เกินวันที่เอกสาร (${h.documentDate})`);
  }
  if (!vatOf(st, companyId) || !h.documentDate) return undefined;
  if (type === 'PCN') {
    if (h.claimPeriod && h.claimPeriod !== h.documentDate.slice(0, 7)) {
      return new MockError(422, 'pcn.claim_period_fixed', `ใบลดหนี้จากผู้ขายต้องลดภาษีซื้อในเดือนที่ได้รับ (${h.documentDate.slice(0, 7)}) เลื่อนงวดไม่ได้`);
    }
    return undefined;
  }
  if (inputVatExpired(h.documentDate, h.vendorDocDate)) return undefined; // forfeited: no period is claimed, so none is judged
  const period = claimPeriodOf(type, h);
  if (!claimWindowOk(h.documentDate, h.vendorDocDate, period)) {
    return new MockError(422, 'pb.claim_period_out_of_range', `งวดที่ขอคืนภาษีซื้อ “${period}” ต้องไม่ก่อนเดือนที่บันทึกเอกสาร (${h.documentDate.slice(0, 7)}) และไม่เกิน 6 เดือนนับจากเดือนของใบกำกับภาษีของผู้ขาย (ม.82/3)`);
  }
  return undefined;
}
