import { beforeEach, describe, expect, it } from 'vitest';
import { USER as me } from '../../fixtures/documents';
import { buildSeedState, type MockState } from '../../store';
import { checkInvariants } from '../invariants';
import { toSatang } from '../money';
import { exportFilingText, finalizeFiling, getFiling } from './index';
import { runsOf } from './pnd1';
import { encodable, tis620Byte } from './sso';

// PY3 ruling 6: สปส.1-10 - wage base and contributions from the STORED slips; blockers; the 135-column TIS-620 file from the finalized rows only.
const CO = 'co-vat', NV = 'co-nonvat';
let st: MockState;
beforeEach(() => { st = buildSeedState(); });
const sat = (m: string) => toSatang(m);
const err = (fn: () => unknown): { status?: number; code?: string; title?: string } => { try { fn(); } catch (e) { return e as { code?: string }; } return {}; };
const doc = (id: string) => st.docs.find((d) => d.id === id)!;
const sso = (co = CO, p = '2026-09') => getFiling(st, co, 'SSO1-10', p);
const file = (co = CO, p = '2026-09') => finalizeFiling(st, co, 'SSO1-10', p, sso(co, p).version, me);
const found = (re: RegExp) => checkInvariants(st).some((m) => re.test(m));
const rows = (p: string) => st.filings.find((f) => f.form === 'SSO1-10' && f.companyId === CO && f.period === p)!.payroll!.rows;

describe('TIS-620', () => {
  it('ASCII and the Thai block have a byte; an emoji, an accented Latin letter and a Chinese character do not', () => {
    expect(tis620Byte('ก')).toBe(0xa1); expect(tis620Byte('ฮ')).toBe(0xce); expect(tis620Byte('฿')).toBe(0xdf); expect(tis620Byte('๙')).toBe(0xf9); expect(tis620Byte('A')).toBe(0x41);
    for (const ch of ['😀', 'é', '中', '฻']) expect(tis620Byte(ch), ch).toBeUndefined();
    expect(encodable('สมศรี บัญชีดี Co., Ltd.')).toBe(true);
    expect(encodable('สมศรี 😀')).toBe(false);
  });
});

describe('the figures come from the stored slips', () => {
  it('August: four insured employees at the 17,500 ceiling; employee and employer totals are Σ the slips\' sso / ssoEmployer', () => {
    const f = st.filings.find((x) => x.form === 'SSO1-10' && x.period === '2026-08')!;
    expect(f.payroll!.rows.map((r) => [r.employeeId, r.wageBase, r.sso, r.ssoEmployer])).toEqual(['emp-01', 'emp-02', 'emp-03', 'emp-05'].map((e) => [e, '17500.00', '875.00', '875.00']));
    const slips = runsOf(st, CO, '2026-08').flatMap((d) => d.payroll!.slips);
    const m = sso(CO, '2026-08');
    expect(sat(m.boxes.find((b) => b.code === 'employee')!.amount)).toBe(slips.reduce((n, s) => n + sat(s.sso), 0));
    expect(sat(m.boxes.find((b) => b.code === 'employer')!.amount)).toBe(slips.reduce((n, s) => n + sat(s.ssoEmployer), 0));
    expect(m.boxes.find((b) => b.code === 'total')!.amount).toBe('7000.00');
    expect(m.boxes.find((b) => b.code === 'wage')!.amount).toBe('70000.00');
    expect(m.tieOuts.map((t) => t.diff)).toEqual(['0.00', '0.00']);
  });
  it('an employee in two runs of the month is one row; the SSO monthly cap still holds (875.00 for emp-01 in September across both runs)', () => {
    const r = sso().attachment!.rows.filter((x) => x.name.includes('สมศรี'));
    expect(r).toHaveLength(1);
    expect(r[0].employee).toBe('875.00');
  });
  it('the wage base uses the floor / ceiling the SLIP stored, not today\'s table', () => {
    const s = doc('pr-bonus-09').payroll!.slips.find((x) => x.employeeId === 'emp-01')!; // the employee's LAST slip of the month carries the tables the row uses
    s.tables.ssoCeiling = '10000.00';
    const row = sso().attachment!.rows[0];
    expect(row.wage).toBe('10000.00');
    expect(row.employee).toBe('875.00'); // the contribution is Σ the slip's own sso, not recomputed from the base
  });
  it('an employee not under SSO is not on the return', () => {
    doc('pr-2026-09').payroll!.slips.find((x) => x.employeeId === 'emp-03')!.employee.ssoRegistered = false;
    expect(sso().attachment!.rows.map((r) => r.name)).not.toContain('มาลี ใจงาม');
  });
});

describe('blockers', () => {
  it('a company without the 10-digit SSO employer account is blocked, and the exit is the company settings page; a short number still blocks', () => {
    const m = sso(NV);
    expect(m.blockers.map((b) => b.code)).toEqual(['sso_account']);
    expect(m.blockers[0].href).toBe('/settings/company');
    st.companies.find((c) => c.id === NV)!.ssoEmployerAccountNo = '12345';
    expect(sso(NV).blockers.map((b) => b.code)).toEqual(['sso_account']);
    expect(err(() => file(NV)).code).toBe('filing.blocked');
    st.companies.find((c) => c.id === NV)!.ssoEmployerAccountNo = '1234567890';
    expect(sso(NV).blockers).toEqual([]);
  });
  it('an employee without a national id is a blocker naming them', () => {
    doc('pr-bonus-09').payroll!.slips.find((x) => x.employeeId === 'emp-02')!.employee.nationalId = '';
    expect(sso().blockers.find((b) => b.code === 'employee_nid')!.labelTh).toContain('วิชาญ');
  });
  it('a name that cannot be encoded in TIS-620 blocks and names the employee; finalize is refused; the Thai names of the seed are fine', () => {
    expect(sso().blockers).toEqual([]);
    doc('pr-bonus-09').payroll!.slips.find((x) => x.employeeId === 'emp-01')!.name = 'สมศรี 😀';
    const b = sso().blockers.find((x) => x.code === 'name_encoding')!;
    expect(b.labelTh).toContain('สมศรี 😀');
    expect(b.href).toBe('/payroll/employees/emp-01');
    expect(err(() => file()).code).toBe('filing.blocked');
  });
});

describe('the file "ไฟล์ส่งประกันสังคม"', () => {
  it('a draft has no file', () => expect(err(() => exportFilingText(st, CO, 'SSO1-10', '2026-09')).code).toBe('filing.not_finalized'));
  it('the filed month: one header and one detail per insured employee, every line 135 columns, every column a TIS-620 byte, CRLF', () => {
    const text = exportFilingText(st, CO, 'SSO1-10', '2026-08');
    expect(text.endsWith('\r\n')).toBe(true);
    const lines = text.split('\r\n').slice(0, -1);
    expect(lines).toHaveLength(5);
    for (const l of lines) { expect(l).toHaveLength(135); expect([...l].every((ch) => tis620Byte(ch) !== undefined)).toBe(true); }
    expect(lines[0].slice(0, 23)).toBe('1' + '1234567890' + '000000' + '082569'); // account, branch, BE period
    expect(lines[0].slice(83, 87)).toBe('0500');
    expect(lines[0].slice(87, 93)).toBe('000004');
    expect(lines[0].slice(93, 108)).toBe('000000007000000'); // wages 70,000.00 in satang
    expect(lines[0].slice(108, 123)).toBe('000000000700000'); // contributions 7,000.00 (3,500 + 3,500)
    expect(lines[1].slice(0, 14)).toBe('2' + (rows('2026-08')[0].nationalId));
    expect(lines[1].slice(74, 89)).toBe('000000001750000');
    expect(lines[1].slice(89, 104)).toBe('000000000087500');
    expect(lines[1].slice(104, 119)).toBe('000000000087500');
  });
  it('built from the STORED rows: a later change of the company account or an employee name moves nothing; the stored row is what is written', () => {
    const before = exportFilingText(st, CO, 'SSO1-10', '2026-08');
    st.companies.find((c) => c.id === CO)!.ssoEmployerAccountNo = '9999999999';
    st.parties.find((p) => p.id === 'emp-01')!.name = 'ชื่อใหม่';
    expect(exportFilingText(st, CO, 'SSO1-10', '2026-08')).toBe(before);
    rows('2026-08')[0].name = 'แก้ในแถวที่เก็บ';
    expect(exportFilingText(st, CO, 'SSO1-10', '2026-08')).not.toBe(before); // proves the source is the stored row
  });
  it('the non-VAT company files once its account is set; its file carries that account (as filed)', () => {
    st.companies.find((c) => c.id === NV)!.ssoEmployerAccountNo = '5555555555';
    file(NV);
    st.companies.find((c) => c.id === NV)!.ssoEmployerAccountNo = '0000000000';
    const text = exportFilingText(st, NV, 'SSO1-10', '2026-09');
    expect(text.slice(1, 11)).toBe('5555555555');
    expect(checkInvariants(st)).toEqual([]);
  });
});

describe('single-fault tampers of a filed สปส.1-10', () => {
  const cases: [string, (s: MockState) => void, RegExp][] = [
    ['a row\'s wage base edited', (s) => { s.filings.find((f) => f.form === 'SSO1-10' && f.period === '2026-09')!.payroll!.rows[0].wageBase = '1.00'; }, /row emp-01 wageBase/],
    ['a row\'s employee share edited', (s) => { s.filings.find((f) => f.form === 'SSO1-10' && f.period === '2026-09')!.payroll!.rows[1].sso = '1.00'; }, /row emp-02 sso/],
    ['a row\'s employer share edited', (s) => { s.filings.find((f) => f.form === 'SSO1-10' && f.period === '2026-09')!.payroll!.rows[1].ssoEmployer = '1.00'; }, /row emp-02 ssoEmployer/],
    ['a row\'s national id edited', (s) => { s.filings.find((f) => f.form === 'SSO1-10' && f.period === '2026-09')!.payroll!.rows[2].nationalId = '1100200300400'; }, /row emp-03 nationalId/],
    ['the stored employer total box edited', (s) => { s.filings.find((f) => f.form === 'SSO1-10' && f.period === '2026-09')!.boxes.find((b) => b.code === 'employer')!.amount = '1.00'; }, /boxes are not Σ/],
    ['the stored ceiling of the slip edited (the wage base moves, the row does not)', (s) => { s.docs.find((d) => d.id === 'pr-bonus-09')!.payroll!.slips[0].tables.ssoCeiling = '10000.00'; }, /row emp-01 wageBase/],
    ['the SSO account of the company as filed removed', (s) => { delete s.filings.find((f) => f.form === 'SSO1-10' && f.period === '2026-09')!.company.ssoEmployerAccountNo; }, /SSO employer account/],
    ['a taken run\'s number changed', (s) => { s.docs.find((d) => d.id === 'pr-bonus-09')!.number = 'PR-X'; }, /run pr-bonus-09 is PR-X/],
  ];
  it.each(cases)('%s is caught', (_n, tamper, re) => {
    file();
    expect(checkInvariants(st)).toEqual([]);
    tamper(st);
    expect(found(re), checkInvariants(st).join('\n')).toBe(true);
  });
});
