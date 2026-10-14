export interface BankAccount { id: string; companyId: string; nameTh: string; accountNo?: string; accountCode: string }

/** Bank / cash accounts per company; ids prefixed `ba-` (VAT company) / `nba-` (non-VAT company). */
export const bankAccounts = (): BankAccount[] => [
  { id: 'ba-kbank', companyId: 'co-vat', nameTh: 'กสิกรไทย กระแสรายวัน', accountNo: '012-3-45678-9', accountCode: '1121' },
  { id: 'ba-scb', companyId: 'co-vat', nameTh: 'ไทยพาณิชย์ ออมทรัพย์', accountNo: '405-2-11223-4', accountCode: '1122' },
  { id: 'ba-cash', companyId: 'co-vat', nameTh: 'เงินสดย่อย', accountCode: '1110' },
  { id: 'nba-kbank', companyId: 'co-nonvat', nameTh: 'กสิกรไทย กระแสรายวัน', accountNo: '012-3-45678-9', accountCode: '1121' },
  { id: 'nba-cash', companyId: 'co-nonvat', nameTh: 'เงินสดย่อย', accountCode: '1110' },
];
