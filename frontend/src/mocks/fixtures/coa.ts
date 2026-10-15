import type { AccountingRole } from '../engine/posting';

/** Thai SME chart of accounts (D-26): keeps every code the SP1ab ledger used (1120, 1130, 1170, 1180, 2110, 2151, 4100, 5100). */
export interface Account {
  code: string; nameTh: string; class: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense'; subClass: string;
  parent?: string; postable: boolean; controlRole?: AccountingRole;
}
export type CompanyAccount = Account & { companyId: string };

type Row = [code: string, nameTh: string, subClass: string, parent?: string, controlRole?: AccountingRole];
const CLASS_OF = (code: string): Account['class'] =>
  ({ '1': 'asset', '2': 'liability', '3': 'equity', '4': 'revenue', '5': 'expense' } as const)[code[0] as '1'];

const HEADERS: [string, string, string, string?][] = [
  ['1000', 'สินทรัพย์', 'header'], ['1100', 'สินทรัพย์หมุนเวียน', 'current-asset', '1000'], ['1200', 'สินทรัพย์ไม่หมุนเวียน', 'fixed-asset', '1000'],
  ['2000', 'หนี้สิน', 'header'], ['2100', 'หนี้สินหมุนเวียน', 'current-liability', '2000'], ['3000', 'ส่วนของเจ้าของ', 'header'],
  ['4000', 'รายได้', 'header'], ['5000', 'ค่าใช้จ่าย', 'header'],
];
const POSTABLE: Row[] = [
  ['1110', 'เงินสด', 'cash', '1100'], ['1120', 'เงินฝากธนาคาร', 'bank', '1100'], ['1121', 'ธ.กสิกรไทย กระแสรายวัน', 'bank', '1100'],
  ['1122', 'ธ.ไทยพาณิชย์ ออมทรัพย์', 'bank', '1100'], ['1130', 'ลูกหนี้การค้า', 'receivable', '1100', 'AR'],
  ['1140', 'เงินจ่ายล่วงหน้าผู้ขาย', 'prepayment', '1100', 'VendorPrepayment'], ['1150', 'ค่าใช้จ่ายจ่ายล่วงหน้า', 'prepayment', '1100'],
  ['1170', 'ภาษีซื้อ', 'tax-asset', '1100', 'InputVat'], ['1171', 'ภาษีซื้อยังไม่ถึงกำหนด', 'tax-asset', '1100'],
  ['1180', 'ภาษีถูกหัก ณ ที่จ่าย', 'tax-asset', '1100', 'WhtReceivable'], ['1210', 'อุปกรณ์สำนักงาน', 'fixed-asset', '1200'],
  ['1211', 'ค่าเสื่อมราคาสะสม-อุปกรณ์', 'accumulated-depreciation', '1200'], ['1220', 'ยานพาหนะ', 'fixed-asset', '1200'],
  ['1221', 'ค่าเสื่อมราคาสะสม-ยานพาหนะ', 'accumulated-depreciation', '1200'],
  ['2110', 'เจ้าหนี้การค้า', 'payable', '2100', 'AP'], ['2120', 'ค่าใช้จ่ายค้างจ่าย', 'accrual', '2100'],
  ['2131', 'ภาษีหัก ณ ที่จ่ายค้างจ่าย ภ.ง.ด.3', 'tax-liability', '2100'], ['2132', 'ภาษีหัก ณ ที่จ่ายค้างจ่าย ภ.ง.ด.53', 'tax-liability', '2100'],
  ['2133', 'ภาษีหัก ณ ที่จ่ายค้างจ่าย ภ.ง.ด.1', 'tax-liability', '2100'], ['2134', 'ภาษีหัก ณ ที่จ่ายค้างจ่าย ภ.ง.ด.54', 'tax-liability', '2100'],
  ['2135', 'ภาษีหัก ณ ที่จ่ายค้างจ่าย ภ.ง.ด.2', 'tax-liability', '2100'], ['2140', 'เงินรับล่วงหน้าจากลูกค้า', 'deposit', '2100', 'CustomerDeposit'],
  ['2151', 'ภาษีขาย', 'tax-liability', '2100', 'OutputVat'], ['2152', 'ภาษีมูลค่าเพิ่มค้างจ่าย ภ.พ.36', 'tax-liability', '2100'],
  ['2153', 'ภาษีเงินได้พนักงานค้างจ่าย', 'tax-liability', '2100'], ['2160', 'เงินประกันสังคมค้างจ่าย', 'payroll-liability', '2100'],
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
  ...HEADERS.map(([code, nameTh, subClass, parent]) => ({ code, nameTh, class: CLASS_OF(code), subClass, ...(parent ? { parent } : {}), postable: false })),
  ...POSTABLE.map(([code, nameTh, subClass, parent, controlRole]) => ({
    code, nameTh, class: CLASS_OF(code), subClass, ...(parent ? { parent } : {}), postable: true, ...(controlRole ? { controlRole } : {}),
  })),
];
