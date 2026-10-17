import type { AccountClass } from '@/records/accounts';
import type { AccountingRole } from '../engine/posting';

/** Thai SME chart of accounts (D-26): keeps every code the SP1ab ledger used (1120, 1130, 1170, 1180, 2110, 2151, 4100, 5100). */
export interface Account {
  code: string; nameTh: string; class: AccountClass; subClass: string;
  parent?: string; postable: boolean; controlRole?: AccountingRole;
  /** AC2 (all optional: absent = active, version 1, no mapping). `dimensionRules` is edited in ST2. */
  nameEn?: string; active?: boolean; version?: number; dbdLine?: string; pnd50Box?: string; dimensionRules?: Record<string, 'required' | 'optional' | 'forbidden'>;
}
export type CompanyAccount = Account & { companyId: string };

type Row = [code: string, nameTh: string, subClass: string, parent?: string, controlRole?: AccountingRole];
/** The §5.4 class of a seeded account: by code range and sub-class. A top header takes the main class of its group; its children may be any class of the group. */
const CLASS_OF = (code: string, subClass: string, parent?: string): AccountClass => {
  switch (code[0]) {
    case '1': return parent === '1200' || code === '1200' ? 'non-current-asset' : 'current-asset';
    case '2': return 'current-liability';
    case '3': return 'equity';
    case '4': return subClass === 'other-income' ? 'other-income' : 'sales-revenue';
    default: return code === '5100' ? 'cost-of-sales' : ['5170', '5180', '5210', '5220', '5500'].includes(code) ? 'other-expense' : 'selling-admin-expense';
  }
};
/**
 * Statutory mapping of the seeded chart (docs/research/tax/dbd-fs-lines-and-pnd50.md; the lines are in records/accounts.ts). Balance sheet: by sub-class, with per-code overrides.
 * Folds are the note's own, flagged UNVERIFIED there: prepayments -> 1.3 (ลูกหนี้หมุนเวียนอื่น), accruals / payroll payables -> 3.2, taxes payable and customer advances -> 3.10,
 * undue / claimable input VAT -> 1.9, the opening-balance equity account -> 5.3, retained / current-year -> 5.4.2. Accumulated depreciation maps to 2.10, which is shown net.
 */
const DBD: Record<string, string> = {
  cash: 'bs-cash-and-equivalents', bank: 'bs-cash-and-equivalents', receivable: 'bs-trade-and-other-current-receivables', prepayment: 'bs-trade-and-other-current-receivables',
  'tax-asset': 'bs-other-current-assets', 'current-asset': 'bs-other-current-assets', 'fixed-asset': 'bs-ppe', 'accumulated-depreciation': 'bs-ppe',
  payable: 'bs-trade-and-other-current-payables', accrual: 'bs-trade-and-other-current-payables', 'payroll-liability': 'bs-trade-and-other-current-payables',
  'tax-liability': 'bs-other-current-liabilities', deposit: 'bs-other-current-liabilities', 'current-liability': 'bs-other-current-liabilities',
  capital: 'bs-paid-up-capital', retained: 'bs-unappropriated', 'current-year': 'bs-unappropriated', opening: 'bs-other-capital-surplus',
};
const DBD_BY_CODE: Record<string, string> = { '1180': 'bs-current-tax-asset' }; // withholding tax credits offset corporate income tax (1.7)
/**
 * Profit and loss by code: [DBD format 2.7 line, ภ.ง.ด.50 line]. Finance cost: the seed has no interest account (5200 is bank fees); a finance-cost account is business-related,
 * so it takes ภ.ง.ด.50 7.12, not 6.3. Cost of sales 5100 is a periodic-layout stand-in (3.2 purchases, note C5). Salaries and fees are not split selling vs administrative: administrative, except advertising and freight (selling).
 */
const PL_BY_CODE: Record<string, [string, string]> = {
  '4100': ['pl-revenue-from-sales-or-services', 'p50-revenue-direct'], '4110': ['pl-revenue-from-sales-or-services', 'p50-revenue-direct'], '4120': ['pl-revenue-from-sales-or-services', 'p50-revenue-direct'],
  '4200': ['pl-other-income', 'p50-other-income-misc'], '4210': ['pl-other-income', 'p50-other-income-disposal-gain'],
  '5100': ['pl-cost-of-sales-or-services', 'p50-cogs-purchases'],
  '5110': ['pl-administrative-expenses', 'p50-sga-rent'], '5120': ['pl-administrative-expenses', 'p50-sga-advisory-fees'], '5130': ['pl-selling-expenses', 'p50-sga-commission-advertising'],
  '5140': ['pl-selling-expenses', 'p50-sga-freight'], '5150': ['pl-administrative-expenses', 'p50-sga-entertainment'], '5160': ['pl-administrative-expenses', 'p50-sga-other'],
  '5170': ['pl-other-expenses', 'p50-sga-other-taxes'], '5180': ['pl-other-expenses', 'p50-sga-other-taxes'], '5200': ['pl-administrative-expenses', 'p50-sga-other-fees'],
  '5210': ['pl-other-expenses', 'p50-other-expense-misc'], '5220': ['pl-other-expenses', 'p50-sga-bad-debt'], '5300': ['pl-administrative-expenses', 'p50-sga-depreciation'],
  '5400': ['pl-administrative-expenses', 'p50-sga-employee'], '5410': ['pl-administrative-expenses', 'p50-sga-employee'], '5500': ['pl-other-expenses', 'p50-other-expense-disposal-loss'],
};
const statutory = (code: string, subClass: string): Pick<Account, 'dbdLine' | 'pnd50Box'> => {
  const pl = PL_BY_CODE[code], dbd = pl?.[0] ?? DBD_BY_CODE[code] ?? DBD[subClass];
  return { ...(dbd ? { dbdLine: dbd } : {}), ...(pl ? { pnd50Box: pl[1] } : {}) };
};

const HEADERS: [string, string, string, string?][] = [
  ['1000', 'สินทรัพย์', 'header'], ['1100', 'สินทรัพย์หมุนเวียน', 'current-asset', '1000'], ['1200', 'สินทรัพย์ไม่หมุนเวียน', 'fixed-asset', '1000'],
  ['2000', 'หนี้สิน', 'header'], ['2100', 'หนี้สินหมุนเวียน', 'current-liability', '2000'], ['3000', 'ส่วนของเจ้าของ', 'header'],
  ['4000', 'รายได้', 'header'], ['5000', 'ค่าใช้จ่าย', 'header'],
];
const POSTABLE: Row[] = [
  ['1110', 'เงินสด', 'cash', '1100'], ['1120', 'เงินฝากธนาคาร', 'bank', '1100'], ['1121', 'ธ.กสิกรไทย กระแสรายวัน', 'bank', '1100'],
  ['1122', 'ธ.ไทยพาณิชย์ ออมทรัพย์', 'bank', '1100'], ['1123', 'เงินฝากธนาคาร (สำรอง)', 'bank', '1100'], ['1130', 'ลูกหนี้การค้า', 'receivable', '1100', 'AR'],
  ['1140', 'เงินจ่ายล่วงหน้าผู้ขาย', 'prepayment', '1100', 'VendorPrepayment'], ['1150', 'ค่าใช้จ่ายจ่ายล่วงหน้า', 'prepayment', '1100'],
  ['1170', 'ภาษีซื้อ', 'tax-asset', '1100', 'InputVat'], ['1171', 'ภาษีซื้อยังไม่ถึงกำหนด', 'tax-asset', '1100'],
  ['1172', 'ภาษีมูลค่าเพิ่มชำระเกินยกไป', 'tax-asset', '1100', 'VatCarryForward'], // TX2c [SP-R] name / code: the excess of a finalized ภ.พ.30, carried to the next month
  ['1180', 'ภาษีถูกหัก ณ ที่จ่าย', 'tax-asset', '1100', 'WhtReceivable'], ['1210', 'อุปกรณ์สำนักงาน', 'fixed-asset', '1200'],
  ['1211', 'ค่าเสื่อมราคาสะสม-อุปกรณ์', 'accumulated-depreciation', '1200'], ['1220', 'ยานพาหนะ', 'fixed-asset', '1200'],
  ['1221', 'ค่าเสื่อมราคาสะสม-ยานพาหนะ', 'accumulated-depreciation', '1200'],
  ['2110', 'เจ้าหนี้การค้า', 'payable', '2100', 'AP'], ['2120', 'ค่าใช้จ่ายค้างจ่าย', 'accrual', '2100'],
  ['2131', 'ภาษีหัก ณ ที่จ่ายค้างจ่าย ภ.ง.ด.3', 'tax-liability', '2100'], ['2132', 'ภาษีหัก ณ ที่จ่ายค้างจ่าย ภ.ง.ด.53', 'tax-liability', '2100'],
  ['2133', 'ภาษีหัก ณ ที่จ่ายค้างจ่าย ภ.ง.ด.1', 'tax-liability', '2100'], ['2134', 'ภาษีหัก ณ ที่จ่ายค้างจ่าย ภ.ง.ด.54', 'tax-liability', '2100'],
  ['2135', 'ภาษีหัก ณ ที่จ่ายค้างจ่าย ภ.ง.ด.2', 'tax-liability', '2100'], ['2140', 'เงินรับล่วงหน้าจากลูกค้า', 'deposit', '2100', 'CustomerDeposit'],
  ['2151', 'ภาษีขาย', 'tax-liability', '2100', 'OutputVat'], ['2152', 'ภาษีมูลค่าเพิ่มค้างจ่าย ภ.พ.36', 'tax-liability', '2100'],
  ['2153', 'ภาษีเงินได้พนักงานค้างจ่าย', 'tax-liability', '2100'], ['2154', 'ภาษีมูลค่าเพิ่มค้างจ่าย ภ.พ.30', 'tax-liability', '2100', 'VatPayable'], ['2160', 'เงินประกันสังคมค้างจ่าย', 'payroll-liability', '2100'], // TX2c [SP-R] name / code of 2154 and 1172
  ['2170', 'เงินเดือนค้างจ่าย', 'payroll-liability', '2100'], ['2180', 'เจ้าหนี้พนักงาน', 'payable', '2100', 'EmployeePayable'],
  ['3100', 'ทุนจดทะเบียน', 'capital', '3000'], ['3200', 'กำไรสะสม', 'retained', '3000'], ['3300', 'กำไร(ขาดทุน)ปีปัจจุบัน', 'current-year', '3000'],
  ['3900', 'ส่วนเกินทุนยอดยกมา', 'opening', '3000'],
  ['4100', 'รายได้จากการขายและบริการ', 'sales', '4000'], ['4110', 'รับคืนสินค้า/ลดหนี้', 'contra-sales', '4000', 'SalesReturn'],
  ['4120', 'ส่วนลดจ่าย', 'contra-sales', '4000'], ['4200', 'รายได้อื่น', 'other-income', '4000'], ['4210', 'กำไรจากการจำหน่ายสินทรัพย์', 'other-income', '4000'],
  ['5100', 'ต้นทุนและค่าใช้จ่าย', 'expense', '5000'], ['5110', 'ค่าเช่า', 'expense', '5000'], ['5120', 'ค่าบริการวิชาชีพ', 'expense', '5000'],
  ['5130', 'ค่าโฆษณา', 'expense', '5000'], ['5140', 'ค่าขนส่ง', 'expense', '5000'], ['5150', 'ค่ารับรอง', 'expense', '5000'],
  ['5160', 'ค่าวัสดุสิ้นเปลือง', 'expense', '5000'], ['5170', 'ภาษีซื้อที่ขอคืนไม่ได้', 'expense', '5000', 'InputVatUnclaimed'],
  ['5180', 'ภาษีหัก ณ ที่จ่ายออกแทน', 'expense', '5000', 'WhtExpense'], ['5200', 'ค่าธรรมเนียมธนาคาร', 'expense', '5000'],
  ['5210', 'ผลต่างจากการปัดเศษ', 'expense', '5000'], ['5220', 'หนี้สูญ/ตัดจำหน่ายเล็กน้อย', 'expense', '5000'], ['5300', 'ค่าเสื่อมราคา', 'expense', '5000'],
  ['5400', 'เงินเดือน', 'payroll-expense', '5000'], ['5410', 'เงินสมทบประกันสังคม', 'payroll-expense', '5000'],
  ['5500', 'ขาดทุนจากการจำหน่ายสินทรัพย์', 'expense', '5000'],
];

export const chartOfAccounts = (): Account[] => [
  ...HEADERS.map(([code, nameTh, subClass, parent]): Account => ({ code, nameTh, class: CLASS_OF(code, subClass, parent), subClass, ...(parent ? { parent } : {}), postable: false })),
  ...POSTABLE.map(([code, nameTh, subClass, parent, controlRole]): Account => ({
    code, nameTh, class: CLASS_OF(code, subClass, parent), subClass, ...(parent ? { parent } : {}), postable: true, ...(controlRole ? { controlRole } : {}),
    ...statutory(code, subClass),
  })),
];
