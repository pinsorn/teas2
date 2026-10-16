import type { DocHeader, DocLine, DocType } from '@/domain/types';
import { EXPENSE_CATEGORIES, type ExpenseCategory } from '../fixtures/expense-categories';
import type { MockState } from '../store';
import { MockError } from './log';
import { RATE_BP, vatOf } from './vat';

/** Input VAT rules of the vendor documents (PB, and the notes PCN / PDN that adjust one). [SP-R] - the statute references are the cited sections of the Revenue Code. */
export const isVendorBill = (t: DocType): boolean => t === 'PB' || t === 'PCN' || t === 'PDN';

/** The expense category of a purchase line: the one named on the line, else the picked item's. Reference data (`fixtures/expense-categories`). */
export function categoryOf(st: MockState, companyId: string, l: DocLine): ExpenseCategory | undefined {
  const code = l.expenseCategory ?? st.items.find((i) => i.id === l.itemId && i.companyId === companyId)?.expenseCategory;
  return EXPENSE_CATEGORIES.find((c) => c.code === code);
}

/** ม.82/5 and ม.82/3: input VAT is claimed only by a VAT-registered company, and not on a category whose VAT cannot be claimed (e.g. entertainment). Everything else is cost
 *  (`InputVatUnclaimed`): the VAT on a vendor's tax invoice still exists, it is part of what the purchase cost (A.4). */
export const isRecoverable = (st: MockState, companyId: string, l: DocLine): boolean => vatOf(st, companyId) && categoryOf(st, companyId, l)?.recoverableVat !== false;

const YM = /^(\d{4})-(0[1-9]|1[0-2])$/;
const monthIndex = (ym: string): number => { const m = YM.exec(ym)!; return Number(m[1]) * 12 + Number(m[2]) - 1; };
/** The claim period a document is filed in: the one chosen, else the month of the document (I6). */
export const claimPeriodOf = (h: Pick<DocHeader, 'claimPeriod' | 'documentDate'>): string => h.claimPeriod ?? h.documentDate.slice(0, 7);
/** I6 / ม.82/4: the input VAT is claimed in the month of the document or within the 6 months after it. */
export const claimWindowOk = (documentDate: string, period: string): boolean => {
  if (!YM.test(period) || !YM.test(documentDate.slice(0, 7))) return false;
  const d = monthIndex(period) - monthIndex(documentDate.slice(0, 7));
  return d >= 0 && d <= 6;
};

/** The header as stored at issue: a VAT company's bill is filed in a claim period, the document month unless chosen (a non-VAT company claims nothing). */
export const withClaimPeriod = (st: MockState, companyId: string, type: DocType, h: DocHeader): DocHeader =>
  isVendorBill(type) && vatOf(st, companyId) && !h.claimPeriod && h.documentDate ? { ...h, claimPeriod: h.documentDate.slice(0, 7) } : h;

/** Every command-time input VAT rule of a PB / PCN / PDN, first violation wins (undefined = fine): the vendor can only charge VAT when registered (ม.82/5), the category exists,
 *  the claim period is inside the window (I6). Judged on the TAX CODE, not on the computed VAT, so a zero-priced line cannot slip through. */
export function purchaseProblem(st: MockState, companyId: string, type: DocType, body: { header: DocHeader; lines: DocLine[] }): MockError | undefined {
  if (!isVendorBill(type)) return undefined;
  const vendor = st.parties.find((p) => p.id === body.header.partyId && p.companyId === companyId);
  if (vendor && !vendor.vatRegistered && body.lines.some((l) => RATE_BP[l.taxCode] > 0n)) {
    return new MockError(422, 'pb.vendor_not_vat_registered', `ผู้ขาย “${vendor.name}” ไม่ได้จดทะเบียนภาษีมูลค่าเพิ่ม จึงมีภาษีซื้อไม่ได้ (ม.82/5) ให้เลือกรหัสภาษี “ไม่มีภาษี” ในรายการ`);
  }
  for (const l of body.lines) {
    if (l.expenseCategory && !EXPENSE_CATEGORIES.some((c) => c.code === l.expenseCategory)) {
      return new MockError(422, 'pb.unknown_category', `รายการ “${l.description}” ใช้หมวดค่าใช้จ่าย “${l.expenseCategory}” ที่ไม่มีในระบบ`);
    }
  }
  const period = claimPeriodOf(body.header);
  if (vatOf(st, companyId) && body.header.documentDate && !claimWindowOk(body.header.documentDate, period)) {
    return new MockError(422, 'pb.claim_period_out_of_range', `งวดที่ขอคืนภาษีซื้อ “${period}” ต้องเป็นเดือนของเอกสาร (${body.header.documentDate.slice(0, 7)}) หรือภายใน 6 เดือนถัดไป (ม.82/4)`);
  }
  return undefined;
}
