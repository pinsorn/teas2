import type { SeedParty } from './parties';

/** Employees are parties of their own kind (expense claims are owed to them, §7.6 / D-18): never offered as a customer or a vendor. `emp-01` is the mock user. */
const emp = (companyId: string, id: string, code: string, name: string, bank: string, no: string): SeedParty => ({
  companyId, id, kind: 'employee', code, name, entityKind: 'individual', vatRegistered: false, paymentTermDays: 0, partyGroup: 'general',
  bankAccount: { bankName: bank, accountNo: no, accountName: name },
});

export const vatEmployees = (): SeedParty[] => [
  emp('co-vat', 'emp-01', 'E01', 'สมศรี บัญชีดี', 'ธนาคารกสิกรไทย', '201-1-10001-1'),
  emp('co-vat', 'emp-02', 'E02', 'วิชาญ ขยันงาน', 'ธนาคารไทยพาณิชย์', '202-2-20002-2'),
  emp('co-vat', 'emp-03', 'E03', 'มาลี ใจงาม', 'ธนาคารกรุงเทพ', '203-3-30003-3'),
];
export const nonVatEmployees = (): SeedParty[] => [
  emp('co-nonvat', 'nemp-01', 'E01', 'บุญมา ทำดี', 'ธนาคารกรุงไทย', '301-1-40004-4'),
  emp('co-nonvat', 'nemp-02', 'E02', 'สายใจ รักงาน', 'ธนาคารกรุงศรีอยุธยา', '302-2-50005-5'),
];
