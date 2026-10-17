import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Actor, DocLine, EmployeeSnapshot, PayItems } from '@/domain/types';
import { PAYROLL_TABLES } from '../fixtures/payroll-tables';
import { PERMISSIONS_BY_ROLE } from '../permissions';
import { employeeImpl } from '../records/employees';
import { setSettings } from '../settings';
import { buildSeedState, loadState, resetState, type MockState } from '../store';
import { testServer } from '../test-server';
import { cancel, compute, createDraft, issue, revise } from './commands';
import { checkInvariants } from './invariants';
import { derivedLocks } from './locks';
import type { MockError } from './log';
import { computeSlip, inputOf, refuseLaterRun, ssoOf, type SlipInput } from './payroll';

const EMP: EmployeeSnapshot = { name: 'ทดสอบ เงินเดือน', maritalStatus: 'single', spouseHasIncome: false, children: 0, otherAllowances: '0.00', ssoRegistered: true, salary: '30000.00', startDate: '2025-01-01' };
const ZERO = { income: '0.00', pit: '0.00', sso: '0.00' };
const input = (month: string, items: Partial<PayItems>, over: Partial<SlipInput> = {}): SlipInput => ({
  employeeId: 'e1', employee: EMP, tables: PAYROLL_TABLES, items: { salary: EMP.salary, ...items }, month, prior: ZERO, monthSso: '0.00', sameMonthPrior: false, ...over,
});

describe('SSO (SP-R A.7): 5 % of salary clamped to 1,650 .. 17,500, max 875.00 a month', () => {
  it('salary 1,000.00 is lifted to the 1,650 floor: 82.50', () => expect(ssoOf(PAYROLL_TABLES, '1000.00')).toBe('82.50'));
  it('salary 30,000.00 is cut to the 17,500 ceiling: 875.00', () => expect(ssoOf(PAYROLL_TABLES, '30000.00')).toBe('875.00'));
  it('no salary, no SSO', () => expect(ssoOf(PAYROLL_TABLES, '0.00')).toBe('0.00'));
});

describe('PIT vectors (projected annual income, ม.50(1))', () => {
  // 30,000 / month, single, no children, no YTD: projected 360,000 - expense 100,000 (cap) - personal 60,000 - SSO 10,500 = 189,500 -> (189,500 - 150,000) x 5 % = 1,975.00
  it('January: 1,975.00 / 12 = 164.58', () => {
    const s = computeSlip(input('2026-01', {}));
    expect(s).toMatchObject({ gross: '30000.00', sso: '875.00', ssoEmployer: '875.00', pit: '164.58', net: '28960.42', ytdIncome: '30000.00', ytdPit: '164.58' });
  });
  // October with 9 x 164.58 = 1,481.22 withheld: (1,975.00 - 1,481.22) / 3 months left = 164.5933 -> 164.59 (half away from zero)
  it('October after nine January-style months: (1,975.00 - 1,481.22) / 3 = 164.59', () => {
    const s = computeSlip(input('2026-10', {}, { prior: { income: '270000.00', pit: '1481.22', sso: '7875.00' } }));
    expect(s.pit).toBe('164.59');
    expect(s).toMatchObject({ ytdIncome: '300000.00', ytdPit: '1645.81', ytdSso: '8750.00', net: '28960.41' });
  });
  // SSO allowance is what is projected to be paid, not always the 10,500 cap: salary 17,000 pays 850 a month = 10,200 a year.
  // January with a 200,000 bonus: gross 217,000, projected 217,000 + 17,000 x 11 = 404,000 - 100,000 - 60,000 - 10,200 = 233,800 -> 83,800 x 5 % = 4,190.00 -> / 12 = 349.1667 -> 349.17
  it('a projected SSO below the cap is deducted as projected (10,200, not 10,500)', () => {
    const s = computeSlip(input('2026-01', { salary: '17000.00', bonus: '200000.00' }, { employee: { ...EMP, salary: '17000.00' } }));
    expect(s).toMatchObject({ gross: '217000.00', sso: '850.00', pit: '349.17' });
  });
  it('allowances: a married employee with a non-earning spouse, two children and 20,000 of other allowances', () => {
    // 60,000 + 60,000 + 2 x 30,000 + 20,000 = 200,000 + SSO 10,500 -> projected 360,000 - 100,000 - 210,500 = 49,500 -> 0 tax
    const s = computeSlip(input('2026-01', {}, { employee: { ...EMP, maritalStatus: 'married', children: 2, otherAllowances: '20000.00' } }));
    expect(s.pit).toBe('0.00');
    // a married employee whose spouse earns gets no spouse allowance: the single employee's figures (189,500 taxable)
    expect(computeSlip(input('2026-01', {}, { employee: { ...EMP, maritalStatus: 'married', spouseHasIncome: true, children: 0 } })).pit).toBe('164.58'); // spouse earns: same as single
  });
  it('a higher band: 100,000 / month, bands 5 / 10 / 15 / 20 %', () => {
    // projected 1,200,000 - 100,000 - 60,000 - 10,500 = 1,029,500: 150k-300k 5 % = 7,500; 300k-500k 10 % = 20,000; 500k-750k 15 % = 37,500; 750k-1M 20 % = 50,000; 1M-1,029,500 25 % = 7,375 -> 122,375.00 / 12 = 10,197.9167 -> 10,197.92
    const s = computeSlip(input('2026-01', { salary: '100000.00' }, { employee: { ...EMP, salary: '100000.00' } }));
    expect(s.pit).toBe('10197.92');
  });
  it('never negative: an employee who has already had more withheld than the year needs', () => {
    expect(computeSlip(input('2026-12', {}, { prior: { income: '330000.00', pit: '9999.00', sso: '9625.00' } })).pit).toBe('0.00');
  });
});

describe('second run in the same month: the incremental method', () => {
  // September: the regular run is in the YTD (270,000 income, 1,481.22 PIT, 7,875.00 SSO, 875.00 SSO this month). A 50,000 bonus run (no salary, so no SSO).
  // tax(projection with the bonus) = 270,000 + 50,000 + 30,000 x 3 = 410,000 - 100,000 - 60,000 - 10,500 = 239,500 -> 89,500 x 5 % = 4,475.00
  // tax(projection without it)     = 360,000                                                            -> 189,500 -> 1,975.00
  // the bonus costs 4,475.00 - 1,975.00 = 2,500.00 of tax: withheld on the bonus alone (no division by the months left)
  it('PIT is tax(with the run) - tax(without it)', () => {
    const s = computeSlip(input('2026-09', { salary: '0.00', bonus: '50000.00' }, { prior: { income: '270000.00', pit: '1481.22', sso: '7875.00' }, monthSso: '875.00', sameMonthPrior: true }));
    expect(s).toMatchObject({ gross: '50000.00', sso: '0.00', ssoEmployer: '0.00', pit: '2500.00', net: '47500.00', ytdIncome: '320000.00', ytdPit: '3981.22' });
  });
  it('a second run with salary withholds only what is left under the 875.00 monthly cap', () => {
    const s = computeSlip(input('2026-09', { salary: '10000.00' }, { prior: { income: '270000.00', pit: '1481.22', sso: '7875.00' }, monthSso: '700.00', sameMonthPrior: true }));
    expect(s.sso).toBe('175.00'); // 5 % of 10,000 = 500, but only 875 - 700 is left
    expect(s.ssoEmployer).toBe('175.00');
  });
  it('once the month is at the cap a second salary run withholds nothing', () => {
    expect(computeSlip(input('2026-09', { salary: '10000.00' }, { monthSso: '875.00', sameMonthPrior: true })).sso).toBe('0.00');
  });
});

describe('proration and SSO registration', () => {
  it('a joiner on 15 Oct is paid 17 / 31 of the salary; SSO is on the prorated salary', () => {
    const s = computeSlip(input('2026-10', {}, { employee: { ...EMP, startDate: '2026-10-15' } }));
    expect(s).toMatchObject({ salaryPaid: '16451.61', gross: '16451.61', sso: '822.58', proratedDays: 17, daysInMonth: 31, pit: '0.00' }); // 30,000 x 17 / 31 = 16,451.6129; 5 % = 822.58
  });
  it('a leaver on 20 Sep is paid 20 / 30; the last month settles the year (one month left)', () => {
    const s = computeSlip(input('2026-09', {}, { employee: { ...EMP, endDate: '2026-09-20' }, prior: { income: '240000.00', pit: '1316.64', sso: '7000.00' } }));
    expect(s).toMatchObject({ salaryPaid: '20000.00', proratedDays: 20, daysInMonth: 30, sso: '875.00' });
    expect(s.pit).toBe('0.00'); // projected 260,000 - 100,000 - 60,000 - 7,875 = 92,125: under 150,000, nothing to withhold
  });
  it('a full month has no proration marker', () => expect(computeSlip(input('2026-09', {})).proratedDays).toBeUndefined());
  it('not registered with the SSO: none withheld, none paid by the employer, and no SSO allowance in the projection', () => {
    const s = computeSlip(input('2026-01', {}, { employee: { ...EMP, ssoRegistered: false } }));
    expect(s).toMatchObject({ sso: '0.00', ssoEmployer: '0.00' });
    // taxable = 360,000 - 100,000 - 60,000 = 200,000 -> 2,500.00 / 12 = 208.33
    expect(s.pit).toBe('208.33');
  });
  it('other income and deductions: net = gross - PIT - SSO - other deduction', () => {
    const s = computeSlip(input('2026-01', { overtime: '1200.50', allowance: '800.00', otherIncome: '99.99', otherDeduction: '500.00' }));
    expect(s.gross).toBe('32100.49');
    expect(s.net).toBe(fromS(toS(s.gross) - toS(s.pit) - toS(s.sso) - 50000));
  });
});

const toS = (m: string) => Math.round(Number(m) * 100);
const fromS = (n: number) => (n / 100).toFixed(2);

// ================================================================ the books: seeded runs, issue, revise, cancel, tampers

beforeAll(() => testServer.listen({ onUnhandledFrame: 'error' }));
afterEach(() => testServer.resetHandlers());
afterAll(() => testServer.close());

const ME: Actor = { kind: 'user', id: 'u-1', name: 'สมศรี บัญชีดี' };
const SAL: Record<string, string> = { 'emp-01': '120000.00', 'emp-02': '30000.00', 'emp-03': '22000.00', 'emp-04': '25000.00', 'emp-05': '28000.00', 'nemp-01': '15000.00', 'nemp-02': '12500.00', 'nemp-03': '18000.00' };
let st: MockState, n = 0;
beforeEach(() => { localStorage.clear(); resetState(); setSettings({ companyKey: 'vat', role: 'accountant', screenState: 'normal' }); st = buildSeedState(); });

const err = (fn: () => unknown): MockError => { try { fn(); } catch (e) { return e as MockError; } throw new Error('expected a refusal'); };
const doc = (id: string) => st.docs.find((d) => d.id === id)!;
const slip = (run: string, emp: string) => doc(run).payroll!.slips.find((s) => s.employeeId === emp)!;
const ents = (id: string) => st.journals.find((j) => j.docId === id)?.preview.entries ?? [];
const sat = (m: string) => Math.round(Number(m) * 100);
const row = (emp: string, pay: Partial<PayItems> = {}): DocLine => ({ id: `t-${++n}`, description: '', qty: '1', unit: '', unitPrice: '0.00', taxCode: 'EX', employeeId: emp, pay: { salary: SAL[emp], ...pay } });
const draft = (lines: DocLine[], date = '2026-10-14', co = 'co-vat') => createDraft(st, co, 'PR', { header: { documentDate: date, reference: 'ทดสอบ' }, lines }, ME, `k${++n}`);
const post = (lines: DocLine[], date = '2026-10-14') => { const d = draft(lines, date); return issue(st, d.id, d.version, ME); };
/** Σ of a role's debit (or credit) over a journal entry, by the rule text "<level>: <role> → <code>". */
const role = (e: { lines: { debit: string; credit: string; rule: string }[] }, r: string, side: 'debit' | 'credit') => e.lines.filter((l) => l.rule.includes(`: ${r} → `)).reduce((a, l) => a + sat(l[side]), 0);
/** Invariants after ONE fault was written into a fresh seed. */
const tamper = (fn: (s: MockState) => void): string[] => { const s = buildSeedState(); fn(s); return checkInvariants(s); };
const stored = (s: MockState, id: string) => s.docs.find((d) => d.id === id)!;

describe('the seeded payroll (D-23): five runs through the engine', () => {
  it('every ledger invariant holds, including the payroll ones', () => {
    expect(checkInvariants(st)).toEqual([]);
    for (const id of ['pr-2026-08', 'pr-2026-09', 'pr-bonus-09', 'npr-2026-09']) expect(doc(id).status, id).toBe('issued');
    expect(doc('pr-2026-10').status).toBe('draft');
    expect(doc('pr-2026-09').number).toBe('PR-202609-0001');
    expect(doc('pr-bonus-09').number).toBe('PR-202609-0002'); // a second run in the same month
    for (const d of st.docs.filter((x) => x.type === 'PR' && x.payroll)) for (const sl of d.payroll!.slips) expect(computeSlip(inputOf(sl)), `${d.id} ${sl.employeeId}`).toEqual(sl); // every issued slip recomputes from what it stored
  });

  it('the year-to-date chain (ruling 2): each slip takes the earlier slips of the year, the second September run takes both', () => {
    const aug = slip('pr-2026-08', 'emp-01'), sep = slip('pr-2026-09', 'emp-01'), bonus = slip('pr-bonus-09', 'emp-01');
    expect(aug.prior).toEqual({ income: '0.00', pit: '0.00', sso: '0.00' });
    expect(sep.prior).toEqual({ income: aug.gross, pit: aug.pit, sso: aug.sso });
    expect(sep.sameMonthPrior).toBe(false);
    expect(bonus.prior.income).toBe(((sat(aug.gross) + sat(sep.gross)) / 100).toFixed(2));
    expect(bonus.sameMonthPrior).toBe(true);
    expect(bonus.monthSso).toBe(sep.sso); // 875.00 already withheld in September
    expect(slip('pr-bonus-09', 'emp-02').ytdIncome).toBe('70000.00'); // 30,000 (Aug) + 30,000 (Sep) + the 10,000 bonus
  });

  it('a bonus run is taxed incrementally (ruling 3): 20,000 inside the 10 % band costs 2,000.00, no salary so no SSO (ruling 4)', () => {
    const b = slip('pr-bonus-09', 'emp-01');
    expect(b).toMatchObject({ gross: '20000.00', sso: '0.00', ssoEmployer: '0.00', pit: '2000.00', net: '18000.00' });
  });

  it('the leaver is paid 20 / 30 of September and the joiner will be paid 17 / 31 of October', () => {
    expect(slip('pr-2026-09', 'emp-05')).toMatchObject({ salaryPaid: '18666.67', proratedDays: 20, daysInMonth: 30 }); // 28,000 x 20 / 30 = 18,666.67
  });

  it('the opening balance feeds the chain only when it is of the run\'s year (ruling 2)', () => {
    expect(slip('npr-2026-09', 'nemp-01').prior.income).toBe('0.00'); // nob-1's cut-off is 2025-12-31: its payroll (180,000.00) is last year's
    doc('nob-1').header.documentDate = '2026-06-30'; // synthetic: an opening balance of THIS year
    const d = draft([row('nemp-01')], '2026-10-10', 'co-nonvat');
    const c = compute(st, 'co-nonvat', 'PR', { header: d.header, lines: d.lines });
    expect(c.payroll!.slips[0].ytdIncome).toBe('210000.00'); // 180,000 (opening) + 15,000 (September) + 15,000 (this run)
    expect(compute(st, 'co-nonvat', 'PR', { header: d.header, lines: d.lines }).payroll!.slips[0].ytdPit).not.toBe('0.00'); // the opening PIT 2,400.00 is in the chain
  });
});

describe('posting (ruling 6)', () => {
  it('the September journal is the slips: expense, payables, other deduction under the employee name; Dr = Cr; dated the pay date', () => {
    const d = doc('pr-2026-09'), [e] = ents('pr-2026-09'), s = d.payroll!.slips;
    const sum = (k: 'gross' | 'pit' | 'sso' | 'ssoEmployer' | 'net') => s.reduce((a, x) => a + sat(x[k]), 0);
    expect(e.date).toBe('2026-09-30');
    expect(role(e, 'SalaryExpense', 'debit')).toBe(sum('gross'));
    expect(role(e, 'SsoExpense', 'debit')).toBe(sum('ssoEmployer'));
    expect(role(e, 'PitPayable', 'credit')).toBe(sum('pit'));
    expect(role(e, 'SsoPayable', 'credit')).toBe(sum('sso') + sum('ssoEmployer'));
    expect(role(e, 'SalaryPayable', 'credit')).toBe(sum('net'));
    const ded = e.lines.find((l) => l.accountCode === '2180')!;
    expect(ded).toMatchObject({ credit: '500.00', partyName: 'มาลี ใจงาม' });
    expect(e.lines.reduce((a, l) => a + sat(l.debit), 0)).toBe(e.lines.reduce((a, l) => a + sat(l.credit), 0));
    expect(e.lines.map((l) => l.accountCode).sort()).toEqual(['2153', '2160', '2170', '2180', '5400', '5410']);
  });

  it('the document total is the net pay (what 2170 carries); the run lists in the company\'s own books only', () => {
    expect(doc('pr-2026-09').totals).toMatchObject({ total: '185692.67', net: '185692.67', vat: '0.00' });
    expect(doc('npr-2026-09').companyId).toBe('co-nonvat');
    expect(st.journals.find((j) => j.docId === 'npr-2026-09')!.preview.entries[0].lines.every((l) => st.accounts.some((a) => a.companyId === 'co-nonvat' && a.code === l.accountCode))).toBe(true);
  });
});

describe('issue: the October draft', () => {
  it('issues with the joiner prorated 17 / 31, a chain from the September slips, and a journal that is its slips', () => {
    const d = issue(st, 'pr-2026-10', doc('pr-2026-10').version, ME);
    expect(d.number).toBe('PR-202610-0001');
    const j = slip('pr-2026-10', 'emp-04');
    expect(j).toMatchObject({ salaryPaid: '13709.68', proratedDays: 17, daysInMonth: 31, sso: '685.48', pit: '0.00' }); // 25,000 x 17 / 31 = 13,709.68; 5 % = 685.48
    const emp1 = slip('pr-2026-10', 'emp-01'), prev = slip('pr-bonus-09', 'emp-01');
    expect(emp1.prior).toEqual({ income: prev.ytdIncome, pit: prev.ytdPit, sso: prev.ytdSso }); // the bonus run is the latest before it
    expect(emp1.sameMonthPrior).toBe(false);
    expect(slip('pr-2026-10', 'emp-03').prior.income).toBe('44000.00');
    expect(checkInvariants(st)).toEqual([]);
  });

  it('a second salary run in the month withholds only what is left under the 875.00 cap (ruling 4)', () => {
    const r = post([row('emp-02', { salary: '10000.00' })], '2026-09-30');
    expect(r.payroll!.slips[0].sso).toBe('0.00'); // emp-02 already paid 875.00 in September
    expect(r.payroll!.slips[0].sameMonthPrior).toBe(true);
    expect(checkInvariants(st)).toEqual([]);
  });

  it('other deductions are capped at gross - PIT - SSO, never a negative net (ruling 5): the exact remainder passes, a satang more is refused naming the employee', () => {
    const ok = draft([row('emp-03', { otherDeduction: '21125.00' })]); // 22,000 - 0 PIT - 875 SSO
    expect(issue(st, ok.id, ok.version, ME).payroll!.slips[0].net).toBe('0.00');
    const bad = draft([row('emp-02', { otherDeduction: '29125.01' })]); // 30,000 - 875 = 29,125
    const c = compute(st, 'co-vat', 'PR', { header: bad.header, lines: bad.lines });
    expect(c.missing.find((m) => m.code === 'payroll.deduction_exceeds')?.message).toContain('วิชาญ ขยันงาน');
    const e = err(() => issue(st, bad.id, bad.version, ME));
    expect(e).toMatchObject({ status: 422, code: 'payroll.deduction_exceeds' });
    expect(e.title).toContain('วิชาญ ขยันงาน');
    expect(doc(bad.id).status).toBe('draft');
    expect(ents(bad.id)).toHaveLength(0);
  });

  it('the pay date follows every document\'s date rules: a closed month and the future are refused (nothing is written)', () => {
    const closed = draft([row('emp-02')], '2026-06-30');
    expect(err(() => issue(st, closed.id, closed.version, ME)).code).toBe('period.closed');
    const future = draft([row('emp-02')], '2026-10-20');
    expect(err(() => issue(st, future.id, future.version, ME)).code).toBe('doc.future_date');
    expect(ents(closed.id)).toHaveLength(0);
  });

  it('a row needs an employee employed in the month, no duplicates, valid money', () => {
    const c = (lines: DocLine[], date = '2026-10-14') => compute(st, 'co-vat', 'PR', { header: { documentDate: date }, lines }).missing.map((m) => m.message).join(' | ');
    expect(c([])).toContain('ต้องมีพนักงานอย่างน้อย 1 คน');
    expect(c([row('emp-05')])).toContain('ไม่ได้เป็นพนักงานในเดือนนี้'); // left on 20 Sep
    expect(c([row('emp-04')], '2026-09-30')).toContain('ไม่ได้เป็นพนักงานในเดือนนี้'); // starts 15 Oct
    expect(c([row('emp-01'), row('emp-01')])).toContain('มีพนักงานคนนี้ในรอบนี้แล้ว');
    expect(c([row('emp-01', { bonus: '1,0' })])).toContain('จำนวนเงินไม่ถูกต้อง');
    expect(c([row('nemp-01')])).toContain('ไม่พบพนักงาน'); // the other company's employee
  });
});

describe('frozen at issue (ruling 1)', () => {
  it('a later edit of the employee or of the tables never changes an issued slip; every slip still recomputes from what it stored', () => {
    const before = JSON.stringify(doc('pr-bonus-09').payroll);
    const emp = st.parties.find((p) => p.id === 'emp-01')!;
    emp.payroll!.salary = '1.00'; emp.payroll!.children = 9; emp.name = 'ชื่อใหม่';
    const was = PAYROLL_TABLES.personal;
    try {
      PAYROLL_TABLES.personal = '0.00';
      expect(JSON.stringify(doc('pr-bonus-09').payroll)).toBe(before);
      expect(checkInvariants(st)).toEqual([]);
      expect(slip('pr-bonus-09', 'emp-01').tables.personal).toBe('60000.00');
      expect(slip('pr-bonus-09', 'emp-01').employee.name).toBe('สมศรี บัญชีดี');
    } finally { PAYROLL_TABLES.personal = was; }
  });

  it('a revise regenerates the payslips of the rows that changed and keeps every other row exactly as frozen (L-class repost)', () => {
    const emp2 = st.parties.find((p) => p.id === 'emp-02')!;
    emp2.payroll!.salary = '31000.00'; // emp-02 is edited after the run was issued
    st.parties.find((p) => p.id === 'emp-01')!.payroll!.children = 5; // and so is emp-01, whose row the revise leaves alone
    const b = doc('pr-bonus-09'), kept = JSON.stringify(slip('pr-bonus-09', 'emp-01'));
    const lines = b.lines.map((l) => (l.employeeId === 'emp-02' ? { ...l, pay: { ...l.pay!, bonus: '12000.00' } } : l));
    const r = revise(st, b.id, { header: b.header, lines }, b.version, 'แก้โบนัส', ME);
    expect(r.revision).toBe(1);
    expect(JSON.stringify(slip('pr-bonus-09', 'emp-01'))).toBe(kept); // unchanged row: the frozen slip
    expect(slip('pr-bonus-09', 'emp-02')).toMatchObject({ gross: '12000.00' });
    expect(slip('pr-bonus-09', 'emp-02').employee.salary).toBe('31000.00'); // the changed row is frozen again from the master as it is now
    expect(doc('pr-bonus-09').totals.total).toBe(((sat(slip('pr-bonus-09', 'emp-01').net) + sat(slip('pr-bonus-09', 'emp-02').net)) / 100).toFixed(2));
    const kinds = ents('pr-bonus-09').map((e) => e.kind);
    expect(kinds).toEqual(['original', 'reversal', 'correction']);
    expect(checkInvariants(st)).toEqual([]);
  });

  it('cancel reverses the journal; the run before it can then be revised, the one before that still cannot', () => {
    cancel(st, 'pr-bonus-09', doc('pr-bonus-09').version, 'OTHER', 'ทดสอบ', ME);
    expect(doc('pr-bonus-09').status).toBe('cancelled');
    expect(ents('pr-bonus-09').map((e) => e.kind)).toEqual(['original', 'reversal']);
    expect(checkInvariants(st)).toEqual([]);
    const s = doc('pr-2026-09');
    const lines = s.lines.map((l) => (l.employeeId === 'emp-01' ? { ...l, pay: { ...l.pay!, allowance: '2000.00' } } : l));
    expect(revise(st, s.id, { header: s.header, lines }, s.version, 'ปรับ', ME).revision).toBe(1); // no later issued run now
    expect(err(() => cancel(st, 'pr-2026-08', doc('pr-2026-08').version, 'OTHER', 'x', ME)).code).toBe('payroll.later_run'); // pr-2026-09 still holds the same employees
    expect(checkInvariants(st)).toEqual([]);
  });
});

describe('a run a later run builds on (ruling 2)', () => {
  it('revise and cancel are refused with the exit; the lock says why and where to go', () => {
    const s = doc('pr-2026-09');
    const lines = s.lines.map((l) => (l.employeeId === 'emp-01' ? { ...l, pay: { ...l.pay!, allowance: '2000.00' } } : l));
    const r = err(() => revise(st, s.id, { header: s.header, lines }, s.version, 'x', ME));
    expect(r).toMatchObject({ status: 409, code: 'payroll.later_run' });
    expect(r.title).toContain('PR-202609-0002');
    expect(r.title).toContain('แก้ไขในรอบถัดไปด้วยรายการปรับปรุง (รายได้อื่น / รายการหักอื่น)');
    expect(err(() => cancel(st, s.id, s.version, 'OTHER', 'x', ME)).code).toBe('payroll.later_run');
    expect(() => refuseLaterRun(st, s)).toThrow();
    const lock = derivedLocks(st, doc('pr-2026-08')).find((l) => l.kind === 'payroll')!;
    expect(lock.reason).toContain('PR-202609-0001');
    expect(lock.exits.length).toBe(2);
    expect(derivedLocks(st, doc('pr-bonus-09')).some((l) => l.kind === 'payroll')).toBe(false); // the latest run is free
    expect(doc('pr-2026-09').status).toBe('issued'); // nothing was written
  });

  it('issuing a run dated before an issued run of the same employees is refused: the year to date would run backwards', () => {
    const d = draft([row('emp-01')], '2026-08-15');
    const e = err(() => issue(st, d.id, d.version, ME));
    expect(e.code).toBe('payroll.later_run');
    expect(compute(st, 'co-vat', 'PR', { header: d.header, lines: d.lines }).missing.some((m) => m.code === 'payroll.later_run')).toBe(true); // shown before issue
  });

  it('after the October run is issued the second September run is locked too', () => {
    issue(st, 'pr-2026-10', doc('pr-2026-10').version, ME);
    const b = doc('pr-bonus-09');
    expect(err(() => revise(st, b.id, { header: b.header, lines: b.lines }, b.version, 'x', ME)).code).toBe('payroll.later_run');
  });
});

describe('employees (ruling 7)', () => {
  const valid = { code: 'E09', firstName: 'ทดลอง', lastName: 'ระบบ', nationalId: '1100700009903', startDate: '2026-01-01', salary: '20000.00', maritalStatus: 'single', children: 0 };
  const errs = (v: Record<string, unknown>, id?: string) => employeeImpl.validate(v, st, 'co-vat', id);
  it('a national ID needs 13 digits and the checksum, and is unique in the company', () => {
    expect(errs({ ...valid, nationalId: '1100700009902' }).nationalId?.[0]).toContain('ไม่ถูกต้อง'); // wrong last digit
    expect(errs({ ...valid, nationalId: '123' }).nationalId).toBeDefined();
    const taken = st.parties.find((p) => p.id === 'emp-02')!.taxId!;
    expect(errs({ ...valid, nationalId: taken }).nationalId?.[0]).toContain('ใช้แล้ว');
    expect(errs({ ...valid, nationalId: taken }, 'emp-02').nationalId).toBeUndefined(); // an employee keeps their own
    expect(employeeImpl.validate({ ...valid, nationalId: taken }, st, 'co-nonvat').nationalId).toBeUndefined(); // another company is another book
  });
  it('the leaving date is not before the start date', () => {
    expect(errs({ ...valid, endDate: '2025-12-31' }).endDate?.[0]).toContain('ต้องไม่ก่อนวันที่เริ่มงาน');
    expect(errs({ ...valid, endDate: '2026-01-01' }).endDate).toBeUndefined();
  });
  it('a valid employee is created with the payroll master; the form values round-trip', () => {
    expect(errs(valid)).toEqual({});
    const r = employeeImpl.create(st, 'co-vat', { ...valid, maritalStatus: 'married', spouseHasIncome: true, children: 2, otherAllowances: '5000', ssoRegistered: true });
    expect(r).toMatchObject({ id: 'emp-06', name: 'ทดลอง ระบบ', salary: '20000.00', maritalStatus: 'married', spouseHasIncome: true, children: 2, otherAllowances: '5000.00', ssoRegistered: true });
    expect(checkInvariants(st)).toEqual([]);
  });
  it('an employee on any payslip cannot be deleted (deactivate instead); an unused one can', () => {
    const e = err(() => employeeImpl.remove!(st, 'co-vat', 'emp-01'));
    expect(e).toMatchObject({ status: 409, code: 'employee.in_use' });
    expect(e.title).toContain('ปิดใช้งาน');
    expect(st.parties.some((p) => p.id === 'emp-01')).toBe(true);
    const fresh = employeeImpl.create(st, 'co-vat', valid);
    employeeImpl.remove!(st, 'co-vat', String(fresh.id));
    expect(st.parties.some((p) => p.id === fresh.id)).toBe(false);
    expect(employeeImpl.setActive(st, 'co-vat', 'emp-01', false).active).toBe(false); // deactivating is fine
  });
});

describe('what the books would catch (single-fault tampers)', () => {
  it('each fault is named by the invariants; the untouched seed is clean', () => {
    expect(checkInvariants(buildSeedState())).toEqual([]);
    const cases: [string, (s: MockState) => void, string][] = [
      ['a slip PIT edited', (s) => { const x = stored(s, 'pr-2026-09').payroll!.slips[0]; x.pit = (sat(x.pit) / 100 + 1).toFixed(2); }, 'pit'],
      ['a slip net edited', (s) => { stored(s, 'pr-2026-09').payroll!.slips[1].net = '1.00'; }, 'net'],
      ['a stored input (salary) edited', (s) => { stored(s, 'pr-2026-09').payroll!.slips[1].employee.salary = '99999.00'; }, 'its stored inputs give'],
      ['the table version\'s band edited', (s) => { stored(s, 'pr-2026-09').payroll!.slips[0].tables.bands[1].rateBp = 900; }, 'its stored inputs give'],
      ['the year to date edited', (s) => { stored(s, 'pr-bonus-09').payroll!.slips[0].prior.income = '1.00'; }, 'year to date'],
      ['the same-month flag edited', (s) => { stored(s, 'pr-bonus-09').payroll!.slips[0].sameMonthPrior = false; }, 'year to date'],
      ['a slip removed from the run', (s) => { stored(s, 'pr-2026-09').payroll!.slips.pop(); }, 'the slips are for'],
      ['the run total edited', (s) => { stored(s, 'pr-2026-09').totals.total = '1.00'; }, 'totals'],
      ['a journal line edited (PIT payable)', (s) => { const l = s.journals.find((j) => j.docId === 'pr-2026-09')!.preview.entries[0].lines.find((x) => x.accountCode === '2153')!; l.credit = '1.00'; }, 'journal PitPayable'],
      ['an other deduction edited without the journal', (s) => { stored(s, 'pr-2026-09').payroll!.slips[2].otherDeduction = '600.00'; }, 'other deduction'],
    ];
    for (const [what, fn, fragment] of cases) {
      const out = tamper(fn);
      expect(out.length, what).toBeGreaterThan(0);
      expect(out.join('\n'), what).toContain(fragment);
    }
  });

  it('employee payable 2180 ties to the expense claims PLUS the other deductions: drop the deduction line and the books disagree', () => {
    const out = tamper((s) => { const e = s.journals.find((j) => j.docId === 'pr-2026-09')!.preview.entries[0]; e.lines = e.lines.filter((l) => l.accountCode !== '2180'); e.lines.find((l) => l.accountCode === '2170')!.credit = (sat(e.lines.find((l) => l.accountCode === '2170')!.credit) / 100 + 500).toFixed(2); });
    expect(out.join('\n')).toContain('2180');
  });
});

describe('permissions and the wire (ruling 9)', () => {
  const call = (method: string, p: string, body?: unknown) => fetch(`http://localhost/bff/v1${p}`, { method, body: body ? JSON.stringify(body) : undefined, headers: { 'content-type': 'application/json' } });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json = async (r: Response) => r.json() as Promise<Record<string, any>>;

  it('the accountant reads and manages employees and works the runs; the admin only reads employees; the operator has neither', () => {
    const A = PERMISSIONS_BY_ROLE;
    for (const p of ['employee.read', 'employee.manage', 'payroll.read', 'doc.PR.read', 'doc.PR.create', 'doc.PR.issue', 'doc.PR.cancel', 'doc.PR.correct']) expect(A.accountant, p).toContain(p);
    expect(A.admin).toContain('employee.read');
    expect(A.admin).not.toContain('employee.manage');
    expect(A.admin.filter((p) => p.startsWith('doc.PR.'))).toEqual([]);
    expect(A.operator.filter((p) => p.startsWith('doc.PR.') || p.startsWith('employee.') || p === 'payroll.read')).toEqual([]);
  });

  it('forbidden says which permission is missing; the admin cannot manage; a caller\'s own `payroll` block is never believed', async () => {
    setSettings({ companyKey: 'vat', role: 'operator', screenState: 'normal' });
    const f = await call('GET', '/docs/PR');
    expect(f.status).toBe(403);
    expect(JSON.stringify(await json(f))).toContain('doc.PR.read');
    const g = await call('GET', '/records/employee');
    expect(g.status).toBe(403);
    expect(JSON.stringify(await json(g))).toContain('employee.read');
    setSettings({ companyKey: 'vat', role: 'admin', screenState: 'normal' });
    expect((await call('GET', '/records/employee')).status).toBe(200);
    expect((await call('POST', '/records/employee', {})).status).toBe(403);
    setSettings({ companyKey: 'vat', role: 'accountant', screenState: 'normal' });
    const fake = { month: '2026-10', slips: [{ employeeId: 'emp-02', gross: '1.00', net: '1.00', pit: '0.00', sso: '0.00', ssoEmployer: '0.00', otherDeduction: '0.00' }] };
    const d = await json(await call('POST', '/docs/PR', { header: { documentDate: '2026-10-14' }, lines: [row('emp-02')], payroll: fake }));
    expect(d.payroll).toBeUndefined();
    const issued = await json(await call('POST', `/docs/PR/${d.id}/issue`, { version: d.version }));
    expect(issued.payroll.slips[0].gross).toBe('30000.00');
  });

  it('a correction plan for a run a later run builds on is refused before it is shown', async () => {
    const r = await call('POST', '/docs/PR/pr-2026-08/correction-plan', { header: { documentDate: '2026-08-31' }, lines: loadState().docs.find((d) => d.id === 'pr-2026-08')!.lines });
    expect(r.status).toBe(409);
    expect((await json(r)).code).toBe('payroll.later_run');
  });

  it('records: delete is refused for an employee on a slip (the exit says deactivate); a new employee can be deleted; each company sees its own employees only', async () => {
    const r = await call('DELETE', '/records/employee/emp-01');
    expect(r.status).toBe(409);
    expect((await json(r)).code).toBe('employee.in_use');
    const list = await json(await call('GET', '/records/employee?active=all'));
    expect(list.items.map((x: { id: string }) => x.id).sort()).toEqual(['emp-01', 'emp-02', 'emp-03', 'emp-04', 'emp-05']);
    setSettings({ companyKey: 'nonvat', role: 'accountant', screenState: 'normal' });
    const other = await json(await call('GET', '/records/employee?active=all'));
    expect(other.items.map((x: { id: string }) => x.id).sort()).toEqual(['nemp-01', 'nemp-02', 'nemp-03']);
    expect((await call('GET', '/records/employee/emp-01')).status).toBe(404); // company A's employee is not found in B
    const made = await call('POST', '/records/employee', { code: 'E77', firstName: 'ลบได้', lastName: 'ไหม', nationalId: '1100700009903', startDate: '2026-01-01', salary: '10000.00', maritalStatus: 'single', children: 0 });
    expect(made.status).toBe(201);
    const row = await json(made);
    expect((await call('DELETE', `/records/employee/${row.id}`)).status).toBe(204);
  });
});
