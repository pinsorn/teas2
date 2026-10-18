import { tinCheckDigit } from '@/domain/tin';
import type { SeedParty } from './parties';

/** Fictional national ID (13 digits, correct check digit). */
const nid = (n: number) => { const first12 = `1100${String(70000000 + n * 7919).padStart(8, '0')}`; return first12 + tinCheckDigit(first12); };

type Pay = NonNullable<SeedParty['payroll']>;
/** Employees are parties of their own kind (expense claims are owed to them, §7.6 / D-18): never offered as a customer or a vendor. `emp-01` is the mock user.
 *  PY1: the payroll master sits on the party (`payroll`; the national ID is `taxId`). A name is "first last" (a title, when there is one, goes in front). */
const emp = (companyId: string, id: string, code: string, first: string, last: string, bank: string, no: string, n: number, pay: Partial<Pay> & Pick<Pay, 'salary' | 'startDate'>): SeedParty => ({
  companyId, id, kind: 'employee', code, name: `${first} ${last}`, entityKind: 'individual', vatRegistered: false, paymentTermDays: 0, partyGroup: 'general', taxId: nid(n),
  bankAccount: { bankName: bank, accountNo: no, accountName: `${first} ${last}` },
  payroll: { firstName: first, lastName: last, ssoRegistered: true, maritalStatus: 'single', spouseHasIncome: false, children: 0, otherAllowances: '0.00', ...pay },
});

export const vatEmployees = (): SeedParty[] => [
  emp('co-vat', 'emp-01', 'E01', 'สมศรี', 'บัญชีดี', 'ธนาคารกสิกรไทย', '201-1-10001-1', 1, { salary: '120000.00', startDate: '2024-01-01', maritalStatus: 'married', children: 1 }),
  emp('co-vat', 'emp-02', 'E02', 'วิชาญ', 'ขยันงาน', 'ธนาคารไทยพาณิชย์', '202-2-20002-2', 2, { salary: '30000.00', startDate: '2024-06-01' }),
  emp('co-vat', 'emp-03', 'E03', 'มาลี', 'ใจงาม', 'ธนาคารกรุงเทพ', '203-3-30003-3', 3, { salary: '22000.00', startDate: '2025-03-01', otherAllowances: '12000.00' }),
  emp('co-vat', 'emp-04', 'E04', 'ธนา', 'เริ่มงานใหม่', 'ธนาคารกรุงไทย', '204-4-40004-4', 4, { salary: '25000.00', startDate: '2026-10-15' }), // joiner: 17 of October's 31 days (proration)
  emp('co-vat', 'emp-05', 'E05', 'ปราณี', 'ลาออกแล้ว', 'ธนาคารกรุงศรีอยุธยา', '205-5-50005-5', 5, { salary: '28000.00', startDate: '2025-02-01', endDate: '2026-09-20', maritalStatus: 'married', spouseHasIncome: true }), // leaver: 20 of September's 30 days
];
export const nonVatEmployees = (): SeedParty[] => [
  emp('co-nonvat', 'nemp-01', 'E01', 'บุญมา', 'ทำดี', 'ธนาคารกรุงไทย', '301-1-40004-4', 11, { salary: '15000.00', startDate: '2024-01-01' }),
  emp('co-nonvat', 'nemp-02', 'E02', 'สายใจ', 'รักงาน', 'ธนาคารกรุงศรีอยุธยา', '302-2-50005-5', 12, { salary: '12500.00', startDate: '2024-04-01', ssoRegistered: false }),
  emp('co-nonvat', 'nemp-03', 'E03', 'ชาติชาย', 'มั่นคง', 'ธนาคารกสิกรไทย', '303-3-60006-6', 13, { salary: '18000.00', startDate: '2026-03-01', maritalStatus: 'married', children: 2 }),
];
