/** `nameTh` is the account name the record form calls "ชื่อบัญชี". `kind: 'cash'` has no bank / number. `active` (default true) and `version` (default 1) are the master record's. */
export interface BankAccount {
  id: string; companyId: string; kind: 'bank' | 'cash'; bankName?: string; nameTh: string; accountNo?: string; accountCode: string;
  /** The account new receipts / payments default to. */ default?: boolean; active?: boolean; version?: number;
}

/** Bank / cash accounts per company; ids prefixed `ba-` (VAT company) / `nba-` (non-VAT company). */
export const bankAccounts = (): BankAccount[] => [
  { id: 'ba-kbank', companyId: 'co-vat', kind: 'bank', bankName: 'kbank', nameTh: 'กสิกรไทย กระแสรายวัน', accountNo: '012-3-45678-9', accountCode: '1121', default: true },
  { id: 'ba-scb', companyId: 'co-vat', kind: 'bank', bankName: 'scb', nameTh: 'ไทยพาณิชย์ ออมทรัพย์', accountNo: '405-2-11223-4', accountCode: '1122' },
  { id: 'ba-cash', companyId: 'co-vat', kind: 'cash', nameTh: 'เงินสดย่อย', accountCode: '1110' },
  { id: 'nba-kbank', companyId: 'co-nonvat', kind: 'bank', bankName: 'kbank', nameTh: 'กสิกรไทย กระแสรายวัน', accountNo: '012-3-45678-9', accountCode: '1121', default: true },
  { id: 'nba-cash', companyId: 'co-nonvat', kind: 'cash', nameTh: 'เงินสดย่อย', accountCode: '1110' },
];
