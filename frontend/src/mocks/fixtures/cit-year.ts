import type { CitYearData } from '@/domain/filings';

/**
 * Corporate income tax rule values. [SP-R] every number here is a mock rule awaiting SP2's tax research, not a ruled position (O-3); the engine reads them from here and each
 * finalized ภ.ง.ด.50 / 51 freezes the ones it used. Rates in basis points (1 bp = 0.01 %), money in baht strings.
 */
export const CIT_RULES = {
  /** [SP-R] SME test: paid-up capital at most 5 MB AND revenue (ภ.ง.ด.50 2.1) at most 30 MB. */
  sme: { maxPaidUpCapital: '5000000.00', maxRevenue: '30000000.00' },
  /** [SP-R] the ladder on taxable profit: an SME pays 0 on the first 300,000, 15 % up to 3,000,000, 20 % above; any other company 20 % flat. `upTo` null = no limit. */
  ladder: {
    sme: [{ upTo: '300000.00', rateBp: 0 }, { upTo: '3000000.00', rateBp: 1500 }, { upTo: null, rateBp: 2000 }],
    standard: [{ upTo: null, rateBp: 2000 }],
  },
  /** [SP-R] entertainment (กฎกระทรวง 143): deductible up to the larger of 0.3 % of revenue and 0.3 % of paid-up capital, never more than 10 MB. */
  entertainment: { rateBp: 30, cap: '10000000.00' },
  /** [SP-R] public charity / education / sport donations: deductible up to 2 % of the net profit. */
  donationRateBp: 200,
  /** [SP-R] a loss of year Y may be set off in years Y+1 .. Y+5, oldest first. */
  lossYears: 5,
  /** [SP-R] the ภ.ง.ด.51 pays half of the tax on the estimated profit, less the tax withheld in months 1-6. */
  prepaidRateBp: 5000,
  /** [SP-R] a ภ.ง.ด.51 estimate whose tax is under 75 % of the tax the year turned out to need (a shortfall of more than 25 %) draws a warning on the ภ.ง.ด.50. */
  underEstimateBp: 7500,
  /** [SP-R] the ภ.ง.ด.50 is due 150 days after the year end (e-filing is extended by 8 days; the mock keeps the paper date); the ภ.ง.ด.51 at the end of the second month after month 6. */
  pnd50DueDays: 150,
} as const;

const BY = 'สมศรี บัญชีดี';
/** The seed year data (ruling 10). The 2019 loss is past its five years for both seeded years (2025 - 2019 = 6): it shows as expired. The 2025 adjustment is a user entry on line 13. */
export const citYearsSeed = (): (CitYearData & { companyId: string })[] => [
  { companyId: 'co-vat', year: 2025, paidUpCapital: '2000000.00', losses: [{ year: 2019, amount: '50000.00' }, { year: 2021, amount: '120000.00' }, { year: 2023, amount: '80000.00' }],
    adjustments: [{ id: 'cit-adj-1', line: 13, amount: '30000.00', reason: 'รายจ่ายที่หักได้เพิ่มขึ้น ม.65 ทวิ — ค่าฝึกอบรมพนักงาน', at: '2026-10-10T09:00:00+07:00', by: BY }] },
  { companyId: 'co-vat', year: 2026, paidUpCapital: '2000000.00', losses: [{ year: 2019, amount: '50000.00' }, { year: 2021, amount: '120000.00' }, { year: 2023, amount: '80000.00' }], adjustments: [] },
  { companyId: 'co-nonvat', year: 2025, paidUpCapital: '1000000.00', losses: [{ year: 2024, amount: '15000.00' }], adjustments: [] },
  { companyId: 'co-nonvat', year: 2026, paidUpCapital: '1000000.00', losses: [{ year: 2024, amount: '15000.00' }], adjustments: [] },
];
