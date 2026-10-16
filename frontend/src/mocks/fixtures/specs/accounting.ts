import type { DocLine } from '@/domain/types';
import { reverseJv } from '../../engine/journal';
import { USER } from '../documents';
import type { SeedSpec } from '../seed-runner';

/** AC1 journal vouchers seeded THROUGH the engine (D-23): an unbalanced draft (the validation fixture), an accrual with auto-reverse (its reversal is written by the issue itself), a reclass that was then reversed by
 *  jv-rev (a JV reversed once is final), and a non-VAT voucher. Ids are explicit: the named fixtures and the tests refer to them. */
const jl = (doc: string, n: number, accountCode: string, debit: string, credit: string, description: string): DocLine =>
  ({ id: `${doc}-l${n}`, description, qty: '1', unit: '', unitPrice: '0.00', taxCode: 'EX', accountCode, debit, credit });

/** AC3 opening balances. The non-VAT company "started" in 2026: its opening at 2025-12-31 is a 12-line trial balance, two receivables, a payable, one asset and the payroll of two employees; 3900 takes the imbalance.
 *  The VAT company has a DRAFT (the wizard demo): receivables, a payable, a bank account with a deposit in transit - its imbalance shows at step 5. VAT / WHT balances are plain lines [SP-R]. */
const ol = (doc: string, n: number, accountCode: string, debit: string, credit: string, description: string): DocLine => jl(doc, n, accountCode, debit, credit, description);
const NOB_LINES: [string, string, string, string][] = [
  ['1130', '20500.00', '0.00', 'ลูกหนี้การค้ายกมา'], ['1150', '3000.00', '0.00', 'ค่าใช้จ่ายจ่ายล่วงหน้า'], ['1210', '45000.00', '0.00', 'อุปกรณ์สำนักงาน'], ['1211', '0.00', '9000.00', 'ค่าเสื่อมราคาสะสม-อุปกรณ์'], ['2110', '0.00', '6000.00', 'เจ้าหนี้การค้ายกมา'],
  ['2120', '0.00', '4000.00', 'ค่าใช้จ่ายค้างจ่าย'], ['2153', '0.00', '2500.00', 'ภาษีเงินได้พนักงานค้างจ่าย'], ['2160', '0.00', '1500.00', 'ประกันสังคมค้างจ่าย'],
  ['2170', '0.00', '6000.00', 'เงินเดือนค้างจ่าย'], ['3100', '0.00', '30000.00', 'ทุนจดทะเบียน'], ['3200', '0.00', '8000.00', 'กำไรสะสม'],
];

export const ACCOUNTING_SPECS: SeedSpec[] = [
  { id: 'nob-1', type: 'OB', companyId: 'co-nonvat', date: '2025-12-31', status: 'issued', header: { notes: 'ยอดยกมา ณ วันเริ่มใช้ระบบ' },
    lines: NOB_LINES.map(([c, d, cr, t], i) => ol('nob-1', i + 1, c, d, cr, t)),
    opening: { openItems: [
      { side: 'AR', partyId: 'nc-01', docNumber: 'IV-2025-0101', docDate: '2025-11-05', dueDate: '2025-12-05', amount: '12500.00' },
      { side: 'AR', partyId: 'nc-02', docNumber: 'IV-2025-0108', docDate: '2025-12-10', dueDate: '2026-01-09', amount: '8000.00' },
      { side: 'AP', partyId: 'nv-01', docNumber: 'INV-V-7741', docDate: '2025-12-15', dueDate: '2026-01-14', amount: '6000.00' }],
    assets: [{ name: 'เครื่องพิมพ์และคอมพิวเตอร์สำนักงาน', assetClass: 'equipment', cost: '45000.00', accumulated: '9000.00', acquired: '2025-03-01', lifeMonths: 60 }],
    payrollYtd: [{ employeeId: 'nemp-01', income: '180000.00', pit: '2400.00', sso: '9000.00' }, { employeeId: 'nemp-02', income: '150000.00', pit: '1200.00', sso: '9000.00' }], bank: [] } },
  { id: 'ob-d1', type: 'OB', companyId: 'co-vat', date: '2026-06-30', status: 'draft', header: { notes: 'ร่างยอดยกมา (ตัวอย่างวิซาร์ด)' },
    lines: [ol('ob-d1', 1, '1122', '21500.00', '0.00', 'เงินฝากธนาคาร'), ol('ob-d1', 2, '1130', '15000.00', '0.00', 'ลูกหนี้การค้า'), ol('ob-d1', 3, '1150', '2000.00', '0.00', 'ค่าใช้จ่ายจ่ายล่วงหน้า'),
      ol('ob-d1', 4, '2110', '0.00', '7000.00', 'เจ้าหนี้การค้า'), ol('ob-d1', 5, '2120', '0.00', '3000.00', 'ค่าใช้จ่ายค้างจ่าย')],
    opening: { openItems: [
      { side: 'AR', partyId: 'pc-01', docNumber: 'TI-2026-0001', docDate: '2026-05-10', dueDate: '2026-06-09', amount: '9000.00' },
      { side: 'AR', partyId: 'pc-02', docNumber: 'TI-2026-0002', docDate: '2026-06-02', dueDate: '2026-07-02', amount: '6000.00' },
      { side: 'AP', partyId: 'pv-01', docNumber: 'PB-9921', docDate: '2026-06-12', dueDate: '2026-07-12', amount: '7000.00' }],
    assets: [], payrollYtd: [], bank: [{ accountId: 'ba-scb', statement: '20000.00', inTransit: [{ kind: 'deposit', date: '2026-06-29', description: 'เช็คลูกค้านำฝากวันสุดท้าย', amount: '1500.00' }] }] } },
  // the accrual of September's professional fees: reversed automatically on 1 Oct (jv-1-auto)
  { id: 'jv-1', type: 'JV', companyId: 'co-vat', date: '2026-09-30', status: 'issued', header: { reference: 'ค้างจ่ายค่าบริการวิชาชีพ ก.ย.', autoReverse: true },
    lines: [jl('jv-1', 1, '5120', '8000.00', '0.00', 'ค่าบริการวิชาชีพ ก.ย. (ค้างจ่าย)'), jl('jv-1', 2, '2120', '0.00', '8000.00', 'ค่าใช้จ่ายค้างจ่าย')] },
  // a reclass between expense accounts, reversed by jv-rev (a user reversal, 8 Oct)
  { id: 'jv-2', type: 'JV', companyId: 'co-vat', date: '2026-10-05', status: 'issued', header: { reference: 'ย้ายค่าใช้จ่ายผิดหมวด' },
    lines: [jl('jv-2', 1, '5160', '4500.00', '0.00', 'ค่าวัสดุสิ้นเปลือง'), jl('jv-2', 2, '5110', '0.00', '4500.00', 'ค่าเช่า (ลงผิดหมวด)')],
    after: (st) => { reverseJv(st, 'jv-2', USER, { id: 'jv-rev', date: '2026-10-08', reason: 'ลงผิดหมวด ย้ายกลับ' }); } },
  // the validation fixture: debit 1,000.00 against credit 900.00
  { id: 'jv-d1', type: 'JV', companyId: 'co-vat', date: '2026-10-13', status: 'draft', header: { reference: 'ร่างยังไม่สมดุล' },
    lines: [jl('jv-d1', 1, '5110', '1000.00', '0.00', 'ค่าเช่า'), jl('jv-d1', 2, '2120', '0.00', '900.00', 'ค้างจ่าย')] },
  { id: 'njv-1', type: 'JV', companyId: 'co-nonvat', date: '2026-10-06', status: 'issued', header: { reference: 'ค้างจ่ายค่าเช่า' },
    lines: [jl('njv-1', 1, '5110', '3000.00', '0.00', 'ค่าเช่าค้างจ่าย'), jl('njv-1', 2, '2120', '0.00', '3000.00', 'ค่าใช้จ่ายค้างจ่าย')] },
];
