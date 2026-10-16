import type { DocLine } from '@/domain/types';
import { reverseJv } from '../../engine/journal';
import { USER } from '../documents';
import type { SeedSpec } from '../seed-runner';

/** AC1 journal vouchers seeded THROUGH the engine (D-23): an unbalanced draft (the validation fixture), an accrual with auto-reverse (its reversal is written by the issue itself), a reclass that was then reversed by
 *  jv-rev (a JV reversed once is final), and a non-VAT voucher. Ids are explicit: the named fixtures and the tests refer to them. */
const jl = (doc: string, n: number, accountCode: string, debit: string, credit: string, description: string): DocLine =>
  ({ id: `${doc}-l${n}`, description, qty: '1', unit: '', unitPrice: '0.00', taxCode: 'EX', accountCode, debit, credit });

export const ACCOUNTING_SPECS: SeedSpec[] = [
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
