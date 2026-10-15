import type { WhtType } from '../engine/wht';

export type CompanyWhtType = WhtType & { companyId: string };

/**
 * [SP-R] WHT types, rates and form routing are mock reference data, NOT a ruled tax position: Ham has not ruled on them
 * (SP-R R-06: rates, payer modes, 50 tawi). That includes the e-WHT 1 % question and every rate below. Screens and tests
 * must not call any of this "the rule". Codes follow Appendix A.5 (D-34).
 */
// [code, nameTh, rateBp, incomeType, flags]
const RAW: [string, string, number, string, Partial<Pick<WhtType, 'pnd2' | 'pnd54'>>?][] = [
  ['RENT', 'ค่าเช่า', 500, '40(5)'],
  ['SVC', 'ค่าบริการ', 300, '40(8)'],
  ['SVC-IND', 'ค่าบริการ (บุคคลธรรมดา)', 300, '40(8)'],
  ['ADS', 'ค่าโฆษณา', 200, '40(8)'],
  ['PROF', 'ค่าวิชาชีพอิสระ', 300, '40(6)'],
  ['TRANS', 'ค่าขนส่ง', 100, '40(8)'],
  ['COMM', 'ค่านายหน้า', 300, '40(2)'],
  ['ROYAL', 'ค่าลิขสิทธิ์', 300, '40(3)'],
  ['INT', 'ดอกเบี้ย', 100, '40(4)ก'],
  ['INT-IND', 'ดอกเบี้ย (บุคคลธรรมดา)', 1500, '40(4)ก', { pnd2: true }],
  ['PRIZE', 'รางวัลและส่วนลดจากการแข่งขัน', 500, '40(8)'],
  ['AGRI', 'ผลิตผลทางการเกษตร', 75, '40(8)'],
  ['ENTERTAIN', 'นักแสดงสาธารณะ', 500, '40(8)'],
  ['CONTRACT', 'ค่ารับเหมา', 300, '40(7)'],
  ['FOR-SVC', 'ค่าบริการจ่ายต่างประเทศ', 1500, '40(8)', { pnd54: true }],
  ['FOR-ROYAL', 'ค่าลิขสิทธิ์จ่ายต่างประเทศ', 1500, '40(3)', { pnd54: true }],
];

/** The same table for every company, effective from 2020-01-01. */
export const whtTypesFor = (companyId: string): CompanyWhtType[] =>
  RAW.map(([code, nameTh, rateBp, incomeType, flags]) => ({ companyId, code, nameTh, rateBp, incomeType, ...flags, effectiveFrom: '2020-01-01' }));
