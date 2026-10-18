import type { PayrollTables } from '@/domain/types';

/** [SP-R] Thai PIT (ม.50(1), projected annual income) and social-security (SSO) tables. The values are discovery 01 Appendix A.7, which describes TEAS 1's code, not a ruling.
 *  Every payroll slip stores a copy of the table it used, so changing this fixture never changes an issued slip. */
export const PAYROLL_TABLES: PayrollTables = {
  version: 'sp-r-2026-1',
  expenseRateBp: 5000, expenseCap: '100000.00', // 50 % of income, at most 100,000
  personal: '60000.00', spouse: '60000.00', child: '30000.00', ssoAllowanceCap: '10500.00',
  bands: [ // 0 % to 150,000, then 5 / 10 / 15 / 20 / 25 / 30 / 35 %
    { upTo: '150000.00', rateBp: 0 }, { upTo: '300000.00', rateBp: 500 }, { upTo: '500000.00', rateBp: 1000 }, { upTo: '750000.00', rateBp: 1500 },
    { upTo: '1000000.00', rateBp: 2000 }, { upTo: '2000000.00', rateBp: 2500 }, { upTo: '5000000.00', rateBp: 3000 }, { rateBp: 3500 },
  ],
  ssoRateBp: 500, ssoFloor: '1650.00', ssoCeiling: '17500.00', // 5 % of salary clamped to 1,650 .. 17,500 (max 875.00 a month, each side)
};
