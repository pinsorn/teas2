/**
 * Expense categories (SP0 5.5): which account a purchase line posts to, and how its input VAT is treated.
 * Mock reference data read by the item form in M2; the settings screen that edits them is ST2.
 * Account codes are the F4 chart's (fixtures/coa.ts). A capex category has no expense account: it capitalises to its asset class.
 */
export interface ExpenseCategory {
  code: string; nameTh: string; accountCode?: string;
  /** False = the input VAT on this category cannot be claimed (e.g. entertainment). */ recoverableVat: boolean;
  capex?: boolean; assetClass?: string;
}
export const EXPENSE_CATEGORIES: ExpenseCategory[] = [
  { code: 'rent', nameTh: 'ค่าเช่า', accountCode: '5110', recoverableVat: true },
  { code: 'services', nameTh: 'ค่าบริการ', accountCode: '5120', recoverableVat: true },
  { code: 'advertising', nameTh: 'ค่าโฆษณา', accountCode: '5130', recoverableVat: true },
  { code: 'transport', nameTh: 'ค่าขนส่ง', accountCode: '5140', recoverableVat: true },
  { code: 'entertainment', nameTh: 'ค่ารับรอง', accountCode: '5150', recoverableVat: false },
  { code: 'supplies', nameTh: 'ค่าวัสดุสิ้นเปลือง', accountCode: '5160', recoverableVat: true },
  { code: 'capex-equipment', nameTh: 'ซื้อสินทรัพย์ (อุปกรณ์)', recoverableVat: true, capex: true, assetClass: 'equipment' },
  { code: 'cost-of-sales', nameTh: 'ต้นทุนขาย', accountCode: '5100', recoverableVat: true },
];
