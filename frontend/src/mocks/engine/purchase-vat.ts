import { ADJUSTS } from '@/domain/doc-types';
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

/** ม.82/5 and ม.82/3: input VAT is claimed only by a VAT-registered company, and not on a category whose VAT cannot be claimed (e.g. entertainment). Everything else is cost
 *  (`InputVatUnclaimed`, or part of the asset on a capex line - TAS 16): the VAT on a vendor's tax invoice still exists, it is part of what the purchase cost (A.4). */
export const isRecoverable = (st: MockState, companyId: string, l: DocLine): boolean => vatOf(st, companyId) && categoryOf(st, companyId, l)?.recoverableVat !== false;

const YM = /^(\d{4})-(0[1-9]|1[0-2])$/;
const monthIndex = (ym: string): number => { const m = YM.exec(ym)!; return Number(m[1]) * 12 + Number(m[2]) - 1; };
/** The date the claim window starts at (ม.82/3): the vendor's tax-invoice date, else the document date. A PCN has no window (I2): the month it is received = its document date. */
const anchorOf = (type: DocType, h: Pick<DocHeader, 'vendorDocDate' | 'documentDate'>): string => (type === 'PCN' ? h.documentDate : (h.vendorDocDate ?? h.documentDate));
/** The claim period a document is filed in: a PB / PDN the one chosen, else the month of the vendor's tax invoice (I6); a PCN always the month of its document date (I2). */
export const claimPeriodOf = (type: DocType, h: Pick<DocHeader, 'claimPeriod' | 'vendorDocDate' | 'documentDate'>): string =>
  (type === 'PCN' ? undefined : h.claimPeriod) ?? anchorOf(type, h).slice(0, 7);
/** I6 / ม.82/3: the input VAT is claimed in the month of the vendor's tax invoice or within the 6 months after it [SP-R]. */
export const claimWindowOk = (anchorDate: string, period: string): boolean => {
  if (!YM.test(period) || !YM.test(anchorDate.slice(0, 7))) return false;
  const d = monthIndex(period) - monthIndex(anchorDate.slice(0, 7));
  return d >= 0 && d <= 6;
};

/** The header as stored at issue / revise: a VAT company's PB / PDN is filed in a claim period (the vendor invoice month unless chosen); a PCN keeps none, its period is its document month
 *  (a non-VAT company claims nothing). */
export const withClaimPeriod = (st: MockState, companyId: string, type: DocType, h: DocHeader): DocHeader => {
  if (!isVendorBill(type) || !vatOf(st, companyId) || !h.documentDate) return h;
  if (type === 'PCN') { const { claimPeriod: _c, ...rest } = h; void _c; return rest; }
  return h.claimPeriod ? h : { ...h, claimPeriod: claimPeriodOf(type, h) };
};

/** M2: the vendor's VAT status is recorded on the header when the document is first saved and kept after (an API caller cannot rewrite it). A new PB / PDN reads the party master;
 *  a note of a bill inherits the bill's (its VAT was charged under it); `prev` = the stored header of the same document (kept while the vendor stays the same). */
export function withVendorStatus(st: MockState, companyId: string, type: DocType, h: DocHeader, prev?: DocHeader): DocHeader {
  if (!isVendorBill(type)) return h;
  const { vendorVatRegistered: _v, ...rest } = h; void _v;
  const bill = ADJUSTS[type] === 'PB' ? st.docs.find((d) => d.id === h.refDocId && d.companyId === companyId && d.type === 'PB') : undefined;
  const kept = prev && prev.partyId === h.partyId ? prev.vendorVatRegistered : undefined;
  const status = kept ?? bill?.header.vendorVatRegistered ?? st.parties.find((p) => p.id === h.partyId && p.companyId === companyId)?.vatRegistered;
  return status === undefined ? rest : { ...rest, vendorVatRegistered: status };
}

/** Every command-time input VAT rule of a PB / PCN / PDN, first violation wins (undefined = fine): the vendor can only charge VAT when registered (ม.82/5, judged on the status recorded
 *  with the document), the category exists, the vendor invoice is not dated after the bill, the claim period is inside the window (I6) - and a PCN has none (I2).
 *  Judged on the TAX CODE, not on the computed VAT, so a zero-priced line cannot slip through. */
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
  const period = claimPeriodOf(type, h), anchor = anchorOf(type, h).slice(0, 7);
  if (!claimWindowOk(anchor, period)) {
    return new MockError(422, 'pb.claim_period_out_of_range', `งวดที่ขอคืนภาษีซื้อ “${period}” ต้องเป็นเดือนของใบกำกับภาษีของผู้ขาย (${anchor}) หรือภายใน 6 เดือนถัดไป (ม.82/3)`);
  }
  return undefined;
}
