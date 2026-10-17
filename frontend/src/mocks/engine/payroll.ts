import { docViewHref } from '@/descriptors';
import { LIVE } from '@/domain/doc-types';
import type { DocLine, DocTotals, EmployeeSnapshot, IsoDate, Lock, MissingItem, Money, PartySummary, PayItems, PayrollData, PayrollSlip, PayrollTables, PayrollTotals, PayslipLine } from '@/domain/types';
import type { MockState } from '../store';
import { PAYROLL_TABLES } from '../fixtures/payroll-tables';
import { bahtText } from './bahtText';
import type { RolePosting } from './ledger';
import { MockError } from './log';
import { divRoundHalfAway, fromSatang, toSatang } from './money';

// PY1: payroll runs (PR). The money lives here in PURE functions over a slip's stored inputs (`computeSlip`), so "recompute every issued slip from what it stored" is the invariant, literally.
// The state-reading half (`buildRun`) only gathers those inputs: the employee master, the tables, the year-to-date chain, and the SSO already withheld this month. The frontend never computes any of it.

type Stored = MockState['docs'][number];
const fail = (status: number, code: string, title: string) => new MockError(status, code, title);
const big = BigInt;
/** Satang of a money string; NaN for text that is not money (the caller reports it, it never becomes 0). */
const satOf = (m: string | undefined): number => { try { return toSatang(m || '0.00'); } catch { return NaN; } };
/** A typed amount as satang for the calculation: bad or negative text counts as 0 here (`payrollMissing` reports it). */
const pos = (m: string | undefined): number => { const n = satOf(m); return n > 0 ? n : 0; };
const rhd = (n: bigint, d: bigint): number => Number(divRoundHalfAway(n, d)); // half away from zero
const mulDiv = (a: number, b: number, d: number): number => rhd(big(a) * big(b), big(d));

// ---------------------------------------------------------------- the calendar

export const daysInMonth = (month: string): number => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
/** Calendar days of `month` the employee is employed (start .. end, both inclusive); 0 = not employed in the month. */
export function daysEmployed(e: Pick<EmployeeSnapshot, 'startDate' | 'endDate'>, month: string): number {
  const first = `${month}-01`, last = `${month}-${String(daysInMonth(month)).padStart(2, '0')}`;
  const from = e.startDate > first ? e.startDate : first, to = e.endDate && e.endDate < last ? e.endDate : last;
  return to < from ? 0 : Number(to.slice(8, 10)) - Number(from.slice(8, 10)) + 1;
}
/** Months of the year after `month` the employee is still paid: up to the leaving month when they leave this year, else to December. */
const monthsLeft = (e: Pick<EmployeeSnapshot, 'endDate'>, month: string): number => {
  const end = e.endDate && e.endDate.slice(0, 4) === month.slice(0, 4) ? Number(e.endDate.slice(5, 7)) : 12;
  return Math.max(0, end - Number(month.slice(5, 7)));
};

// ---------------------------------------------------------------- SSO and PIT

/** SSO of one month on a (prorated) salary: 5 % of the salary clamped to the floor .. ceiling; no salary, no SSO. */
export function ssoOf(t: PayrollTables, salary: Money): Money {
  const s = pos(salary);
  if (s === 0) return '0.00';
  return fromSatang(mulDiv(Math.min(Math.max(s, satOf(t.ssoFloor)), satOf(t.ssoCeiling)), t.ssoRateBp, 10000));
}
const ssoMonthlyCap = (t: PayrollTables): number => mulDiv(satOf(t.ssoCeiling), t.ssoRateBp, 10000);

/** Annual tax on a taxable income (satang) through the bands; rounded once, half away from zero. */
function taxOf(t: PayrollTables, taxable: number): number {
  let n = 0n, lo = 0;
  for (const b of t.bands) {
    const hi = b.upTo === undefined ? Infinity : satOf(b.upTo);
    if (taxable > lo) n += big(Math.min(taxable, hi) - lo) * big(b.rateBp);
    lo = hi;
    if (taxable <= hi) break;
  }
  return rhd(n, 10000n);
}

export interface SlipInput { employeeId: string; employee: EmployeeSnapshot; tables: PayrollTables; items: PayItems; month: string;
  /** The year to date before this slip: opening balance (when it is this year's) + every earlier issued slip of the employee in the year. */
  prior: { income: Money; pit: Money; sso: Money };
  /** SSO already withheld from the employee in this month by earlier runs. */ monthSso: Money;
  /** An earlier run of this month has a slip for the employee: the incremental method applies. */ sameMonthPrior: boolean }

/** Annual tax on the projected year: what is already behind (`prior`) + this run (`income`, `sso`) + the base salary for every month still to come. */
function projectedTax(i: SlipInput, income: number, sso: number): number {
  const t = i.tables, e = i.employee, left = monthsLeft(e, i.month);
  const monthlySso = e.ssoRegistered ? satOf(ssoOf(t, e.salary)) : 0;
  const year = satOf(i.prior.income) + income + satOf(e.salary) * left;
  const paidSso = Math.min(satOf(t.ssoAllowanceCap), satOf(i.prior.sso) + sso + monthlySso * left);
  const expense = Math.min(mulDiv(year, t.expenseRateBp, 10000), satOf(t.expenseCap));
  const allowances = satOf(t.personal) + (e.maritalStatus === 'married' && !e.spouseHasIncome ? satOf(t.spouse) : 0) + e.children * satOf(t.child) + satOf(e.otherAllowances) + paidSso;
  return taxOf(t, Math.max(0, year - expense - allowances));
}

/** One payslip from its inputs alone (pure). Salary is prorated by calendar days employed; SSO is on that salary, capped per month across runs; PIT is the projected-annual method. */
export function computeSlip(i: SlipInput): PayrollSlip {
  const t = i.tables, e = i.employee, it = i.items, dim = daysInMonth(i.month), days = daysEmployed(e, i.month);
  const salary = pos(it.salary), paid = days >= dim ? salary : mulDiv(salary, days, dim);
  const gross = paid + pos(it.overtime) + pos(it.allowance) + pos(it.bonus) + pos(it.otherIncome);
  const sso = e.ssoRegistered ? Math.min(satOf(ssoOf(t, fromSatang(paid))), Math.max(0, ssoMonthlyCap(t) - satOf(i.monthSso))) : 0;
  const withRun = projectedTax(i, gross, sso);
  // A SECOND run in a month (a bonus, a correction) is taxed incrementally: PIT = tax(projection with this run) - tax(projection without it). The regular method divides the year's remaining tax by the
  // months left, which would spread a one-off payment over months that are already (or will be) withheld on their own; the incremental method puts exactly the extra tax on the extra payment, with no division.
  const pit = Math.max(0, i.sameMonthPrior ? withRun - projectedTax(i, 0, 0) : rhd(big(withRun - satOf(i.prior.pit)), big(monthsLeft(e, i.month) + 1)));
  const ded = pos(it.otherDeduction);
  return {
    employeeId: i.employeeId, name: e.name, gross: fromSatang(gross), pit: fromSatang(pit), sso: fromSatang(sso), ssoEmployer: fromSatang(sso), otherDeduction: fromSatang(ded), net: fromSatang(gross - pit - sso - ded),
    ...(days < dim ? { proratedDays: days } : {}), ytdIncome: fromSatang(satOf(i.prior.income) + gross), ytdPit: fromSatang(satOf(i.prior.pit) + pit),
    items: i.items, employee: e, tables: t, month: i.month, prior: i.prior, monthSso: i.monthSso, sameMonthPrior: i.sameMonthPrior, salaryPaid: fromSatang(paid), daysInMonth: dim, ytdSso: fromSatang(satOf(i.prior.sso) + sso),
  };
}
/** The stored inputs of a slip: recomputing from these must give the slip back (invariant). */
export const inputOf = (s: PayrollSlip): SlipInput => ({ employeeId: s.employeeId, employee: s.employee, tables: s.tables, items: s.items, month: s.month, prior: s.prior, monthSso: s.monthSso, sameMonthPrior: s.sameMonthPrior });
export const slipLine = (s: PayrollSlip): PayslipLine => ({ employeeId: s.employeeId, name: s.name, gross: s.gross, pit: s.pit, sso: s.sso, ssoEmployer: s.ssoEmployer, otherDeduction: s.otherDeduction, net: s.net,
  ...(s.proratedDays !== undefined ? { proratedDays: s.proratedDays } : {}), ytdIncome: s.ytdIncome, ytdPit: s.ytdPit });

export function totalsOfSlips(slips: Pick<PayrollSlip, 'gross' | 'pit' | 'sso' | 'ssoEmployer' | 'net'>[]): PayrollTotals {
  const sum = (k: 'gross' | 'pit' | 'sso' | 'ssoEmployer' | 'net') => fromSatang(slips.reduce((n, s) => n + satOf(s[k]), 0));
  return { gross: sum('gross'), pit: sum('pit'), sso: sum('sso'), ssoEmployer: sum('ssoEmployer'), net: sum('net') };
}
/** The document total of a run is what it pays out: the net pay (what 2170 carries). `gross` is the cost of the pay itself; the employer's SSO is in the journal. */
export function prTotals(slips: PayrollSlip[]): DocTotals {
  const t = totalsOfSlips(slips);
  return { gross: t.gross, discount: '0.00', net: t.net, vat: '0.00', total: t.net, amountInWords: bahtText(t.net) };
}

// ---------------------------------------------------------------- the employee master and the year-to-date chain

const employeeOf = (st: MockState, companyId: string, id: string | undefined): (PartySummary & { companyId: string }) | undefined =>
  st.parties.find((p) => p.id === id && p.companyId === companyId && p.kind === 'employee');
/** The employee as a slip freezes them. */
export function snapshotOf(p: PartySummary): EmployeeSnapshot {
  const x = p.payroll;
  return { name: p.name, ...(p.taxId ? { nationalId: p.taxId } : {}), maritalStatus: x?.maritalStatus ?? 'single', spouseHasIncome: !!x?.spouseHasIncome, children: x?.children ?? 0, otherAllowances: x?.otherAllowances ?? '0.00',
    ssoRegistered: x?.ssoRegistered ?? false, salary: x?.salary ?? '0.00', startDate: x?.startDate ?? '1970-01-01', ...(x?.endDate ? { endDate: x.endDate } : {}) };
}
export const normItems = (p: Partial<PayItems> | undefined): PayItems => {
  const m = (v: string | undefined) => (v === undefined || v === '' ? '0.00' : v);
  return { salary: m(p?.salary), overtime: m(p?.overtime), allowance: m(p?.allowance), bonus: m(p?.bonus), otherIncome: m(p?.otherIncome), otherDeduction: m(p?.otherDeduction) };
};

/** Issued runs of a company (a draft has no slips and counts for nothing). */
const liveRuns = (st: MockState, companyId: string, exceptId?: string): Stored[] =>
  st.docs.filter((d) => d.companyId === companyId && d.type === 'PR' && LIVE.includes(d.status) && !!d.payroll && d.id !== exceptId);
/** Chain order: pay date, then number. `self` (a run being issued has no number yet) comes after every run of its own date. */
const isBefore = (d: Stored, self: { date: IsoDate; number?: string }): boolean =>
  d.header.documentDate < self.date || (d.header.documentDate === self.date && (self.number === undefined || (d.number ?? '') < self.number));
/** The opening balance's year-to-date of an employee, when the opening balance is of the run's year (an earlier year's cut-off says nothing about this year's tax). */
function obYtd(st: MockState, companyId: string, employeeId: string, year: string): { income: number; pit: number; sso: number } {
  const y = { income: 0, pit: 0, sso: 0 };
  for (const d of st.docs) {
    if (d.companyId !== companyId || d.type !== 'OB' || !d.opening || !LIVE.includes(d.status) || d.header.documentDate.slice(0, 4) !== year) continue;
    for (const r of d.opening.payrollYtd) if (r.employeeId === employeeId) { y.income += satOf(r.income) || 0; y.pit += satOf(r.pit) || 0; y.sso += satOf(r.sso) || 0; }
  }
  return y;
}
/** Everything a slip needs from the books: the year to date before it, the SSO already taken this month, and whether an earlier run of the month exists. */
function chainFor(st: MockState, companyId: string, employeeId: string, self: { date: IsoDate; number?: string; id?: string }) {
  const year = self.date.slice(0, 4), month = self.date.slice(0, 7), ob = obYtd(st, companyId, employeeId, year);
  let income = ob.income, pit = ob.pit, sso = ob.sso, monthSso = 0, sameMonthPrior = false;
  for (const d of liveRuns(st, companyId, self.id)) {
    if (d.header.documentDate.slice(0, 4) !== year || !isBefore(d, self)) continue;
    for (const s of d.payroll!.slips) {
      if (s.employeeId !== employeeId) continue;
      income += satOf(s.gross); pit += satOf(s.pit); sso += satOf(s.sso);
      if (s.month === month) { monthSso += satOf(s.sso); sameMonthPrior = true; }
    }
  }
  return { prior: { income: fromSatang(income), pit: fromSatang(pit), sso: fromSatang(sso) }, monthSso: fromSatang(monthSso), sameMonthPrior };
}

type PrBody = { header: { documentDate: IsoDate }; lines: DocLine[] };
/** The slips of a run as the books give them now. A slip of an ISSUED run whose row (employee, pay items) and pay date are unchanged is kept exactly as frozen (ruling 1: a later master or table edit never changes an issued slip);
 *  every other row is computed from the master and the tables as they are now. */
export function buildRun(st: MockState, companyId: string, body: PrBody, selfId?: string): PayrollSlip[] {
  const self = selfId ? st.docs.find((d) => d.id === selfId && d.companyId === companyId) : undefined;
  const date = body.header.documentDate, month = date.slice(0, 7), kept = self && self.payroll && self.header.documentDate === date ? self.payroll.slips : [];
  const seen = new Set<string>(), out: PayrollSlip[] = [];
  for (const l of body.lines) {
    const p = employeeOf(st, companyId, l.employeeId);
    if (!p || seen.has(p.id)) continue;
    seen.add(p.id);
    const items = normItems(l.pay), old = kept.find((s) => s.employeeId === p.id && JSON.stringify(s.items) === JSON.stringify(items));
    out.push(old ?? computeSlip({ employeeId: p.id, employee: snapshotOf(p), tables: structuredClone(PAYROLL_TABLES), items, month, ...chainFor(st, companyId, p.id, { date, number: self?.number, id: self?.id }) }));
  }
  return out;
}
/** The slips a body stands for: its frozen payroll when it has one (issue / revise froze it), else the live computation. */
export const prSlips = (st: MockState, companyId: string, body: PrBody & { payroll?: PayrollData }, selfId?: string): PayrollSlip[] => body.payroll?.slips ?? buildRun(st, companyId, body, selfId);
export const freezePayroll = (st: MockState, companyId: string, body: PrBody, selfId?: string): PayrollData => ({ month: body.header.documentDate.slice(0, 7), slips: buildRun(st, companyId, body, selfId) });
/** The per-line figures `compute` returns: each employee row's net pay. */
export const prCalc = (st: MockState, companyId: string, body: PrBody, selfId?: string) => {
  const slips = buildRun(st, companyId, body, selfId);
  return { lines: body.lines.map((l) => { const s = slips.find((x) => x.employeeId === l.employeeId); return { id: l.id, net: s?.net ?? '0.00', vat: '0.00', total: s?.net ?? '0.00' }; }) };
};

// ---------------------------------------------------------------- what a run still lacks, and what refuses it

const MONEY_KEYS = ['salary', 'overtime', 'allowance', 'bonus', 'otherIncome', 'otherDeduction'] as const;
export function payrollMissing(st: MockState, companyId: string, body: PrBody): MissingItem[] {
  const out: MissingItem[] = [], rows = body.lines.filter((l) => l.employeeId || l.pay), month = body.header.documentDate.slice(0, 7), seen = new Set<string>();
  if (!rows.length) out.push({ field: 'lines', message: 'ต้องมีพนักงานอย่างน้อย 1 คน' });
  rows.forEach((l, i) => {
    const n = i + 1, p = employeeOf(st, companyId, l.employeeId);
    if (!l.employeeId) { out.push({ field: 'lines', message: `รายการที่ ${n}: ต้องเลือกพนักงาน` }); return; }
    if (!p) { out.push({ field: 'lines', message: `รายการที่ ${n}: ไม่พบพนักงาน` }); return; }
    if (seen.has(p.id)) out.push({ field: 'lines', message: `${p.name}: มีพนักงานคนนี้ในรอบนี้แล้ว (หนึ่งรายการต่อพนักงาน)` });
    seen.add(p.id);
    for (const k of MONEY_KEYS) { const v = l.pay?.[k]; if (v !== undefined && v !== '' && !(satOf(v) >= 0)) out.push({ field: 'lines', message: `${p.name}: จำนวนเงินไม่ถูกต้อง` }); }
    if (month.length === 7 && daysEmployed(snapshotOf(p), month) === 0) out.push({ field: 'lines', message: `${p.name}: ไม่ได้เป็นพนักงานในเดือนนี้ (เริ่มงาน ${p.payroll?.startDate ?? '-'}${p.payroll?.endDate ? ` ลาออก ${p.payroll.endDate}` : ''})` });
  });
  return out;
}

/** Runs issued AFTER this one (later pay date, or the same date and a later number) that have a slip for any of `employeeIds` in the same year. */
export function laterRuns(st: MockState, companyId: string, self: { id?: string; date: IsoDate; number?: string }, employeeIds: string[]): Stored[] {
  return liveRuns(st, companyId, self.id).filter((d) => d.header.documentDate.slice(0, 4) === self.date.slice(0, 4) && !isBefore(d, { ...self, number: self.number ?? '￿' }) && d.payroll!.slips.some((s) => employeeIds.includes(s.employeeId)));
}
const laterTitle = (later: Stored[]) =>
  `มีรอบเงินเดือนที่ออกภายหลัง (${later.map((d) => d.number).join(', ')}) ที่มีพนักงานของรอบนี้ ยอดสะสมของพนักงานต่อเนื่องกันจึงแก้ไขหรือยกเลิกรอบนี้ไม่ได้ ทางออก: แก้ไขในรอบถัดไปด้วยรายการปรับปรุง (รายได้อื่น / รายการหักอื่น) หรือยกเลิกรอบถัดไปก่อน`;
/** Ruling 2: revising / cancelling a run is refused while a later issued run of the year has a slip for any of its employees. */
export function refuseLaterRun(st: MockState, d: Stored): void {
  if (d.type !== 'PR' || !d.payroll) return;
  const later = laterRuns(st, d.companyId, { id: d.id, date: d.header.documentDate, number: d.number }, d.payroll.slips.map((s) => s.employeeId));
  if (later.length) throw fail(409, 'payroll.later_run', laterTitle(later));
}
/** The same fact as a lock the document reads with (derived, never stored): the reason and its exits. */
export function payrollLock(st: MockState, ref: { id?: string; type?: string }): Lock | undefined {
  const d = ref.type === 'PR' && ref.id ? st.docs.find((x) => x.id === ref.id) : undefined;
  if (!d?.payroll) return undefined;
  const later = laterRuns(st, d.companyId, { id: d.id, date: d.header.documentDate, number: d.number }, d.payroll.slips.map((s) => s.employeeId));
  if (!later.length) return undefined;
  const last = later[later.length - 1], href = docViewHref('PR', last.id);
  return { kind: 'payroll', reason: `มีรอบเงินเดือนที่ออกภายหลัง (${later.map((x) => x.number).join(', ')}) ที่มีพนักงานของรอบนี้ ยอดสะสมของพนักงานต่อเนื่องกัน`,
    exits: ['แก้ไขในรอบถัดไปด้วยรายการปรับปรุง (รายได้อื่น / รายการหักอื่น)', `ยกเลิกรอบถัดไป ${last.number} ก่อน`], ...(href ? { href } : {}) };
}

/** Everything that refuses a run before anything is written (issue, revise, compute): a later run in the books, and an other deduction larger than what is left of the pay (never a negative net). */
export function payrollProblem(st: MockState, companyId: string, type: string, body: PrBody, selfId?: string): MockError | undefined {
  if (type !== 'PR') return undefined;
  const self = selfId ? st.docs.find((d) => d.id === selfId) : undefined, slips = buildRun(st, companyId, body, selfId);
  const later = laterRuns(st, companyId, { id: selfId, date: body.header.documentDate, number: self?.number }, slips.map((s) => s.employeeId));
  if (later.length) return fail(409, 'payroll.later_run', laterTitle(later));
  for (const s of slips) {
    const room = satOf(s.gross) - satOf(s.pit) - satOf(s.sso);
    if (satOf(s.otherDeduction) > room) return fail(422, 'payroll.deduction_exceeds', `รายการหักอื่นของ ${s.name} (${s.otherDeduction}) มากกว่าเงินที่เหลือหลังหักภาษีและประกันสังคม (${fromSatang(Math.max(0, room))}) ลดรายการหักอื่นลง`);
  }
  return undefined;
}

// ---------------------------------------------------------------- posting

/** The run's journal, exactly the frozen slips: salary and the employer's SSO as expense; PIT, SSO (both sides) and the net pay as payables; other deductions under the employee's name on the employee payable (2180). */
export const payrollRows = (d: { payroll?: PayrollData }): RolePosting => {
  const slips = d.payroll?.slips ?? [], sum = (k: 'gross' | 'pit' | 'sso' | 'ssoEmployer' | 'net') => slips.reduce((n, s) => n + satOf(s[k]), 0);
  return [['SalaryExpense', sum('gross'), 0], ['SsoExpense', sum('ssoEmployer'), 0], ['PitPayable', 0, sum('pit')], ['SsoPayable', 0, sum('sso') + sum('ssoEmployer')], ['SalaryPayable', 0, sum('net')],
    ...slips.filter((s) => satOf(s.otherDeduction) > 0).map((s): RolePosting[number] => ['EmployeePayable', 0, satOf(s.otherDeduction), { partyName: s.name }])];
};

// ---------------------------------------------------------------- invariants

/** Ruling 1 + 2: every issued slip recomputes from what it stored; net = gross - PIT - SSO - deduction; the run's totals are its slips'; its journal is the totals per role; each slip's year to date is the opening balance + the earlier slips. */
export function payrollInvariants(st: MockState): string[] {
  const out: string[] = [];
  for (const d of st.docs.filter((x) => x.type === 'PR' && LIVE.includes(x.status) && !!x.payroll)) {
    const slips = d.payroll!.slips, tot = totalsOfSlips(slips);
    if (d.header.documentDate.slice(0, 7) !== d.payroll!.month) out.push(`${d.id}: payroll month ${d.payroll!.month} but dated ${d.header.documentDate}`);
    const rows = d.lines.map((l) => l.employeeId).filter((x): x is string => !!x);
    if (JSON.stringify([...rows].sort()) !== JSON.stringify(slips.map((s) => s.employeeId).sort())) out.push(`${d.id}: the slips are for ${slips.map((s) => s.employeeId).join(', ')} but the rows are ${rows.join(', ')}`);
    for (const s of slips) {
      const w = `${d.id} slip ${s.employeeId}`, back = computeSlip(inputOf(s));
      for (const k of ['gross', 'pit', 'sso', 'ssoEmployer', 'otherDeduction', 'net', 'ytdIncome', 'ytdPit', 'ytdSso', 'salaryPaid'] as const) if (back[k] !== s[k]) out.push(`${w}: ${k} ${s[k]} but its stored inputs give ${back[k]}`);
      if (back.proratedDays !== s.proratedDays) out.push(`${w}: proration ${s.proratedDays ?? 'none'} but its stored inputs give ${back.proratedDays ?? 'none'}`);
      if (satOf(s.net) !== satOf(s.gross) - satOf(s.pit) - satOf(s.sso) - satOf(s.otherDeduction)) out.push(`${w}: net ${s.net} is not gross ${s.gross} - PIT ${s.pit} - SSO ${s.sso} - other deduction ${s.otherDeduction}`);
      if (satOf(s.net) < 0) out.push(`${w}: negative net ${s.net}`);
      const chain = chainFor(st, d.companyId, s.employeeId, { id: d.id, date: d.header.documentDate, number: d.number });
      if (JSON.stringify([chain.prior, chain.monthSso, chain.sameMonthPrior]) !== JSON.stringify([s.prior, s.monthSso, s.sameMonthPrior])) out.push(`${w}: year to date ${JSON.stringify(s.prior)} (month SSO ${s.monthSso}) but the opening balance and the earlier slips give ${JSON.stringify(chain.prior)} (month SSO ${chain.monthSso})`);
    }
    if (satOf(d.totals.total) !== satOf(tot.net) || satOf(d.totals.net) !== satOf(tot.net) || satOf(d.totals.gross) !== satOf(tot.gross)) out.push(`${d.id}: totals ${d.totals.gross} / ${d.totals.total} but its slips give ${tot.gross} / ${tot.net}`);
    const e = st.journals.find((j) => j.docId === d.id)?.preview.entries.filter((x) => x.kind !== 'reversal').pop();
    const role = (r: string, side: 'debit' | 'credit') => (e?.lines ?? []).filter((l) => new RegExp(`: ${r} → `).test(l.rule)).reduce((n, l) => n + satOf(l[side]), 0);
    const want: [string, 'debit' | 'credit', number][] = [['SalaryExpense', 'debit', satOf(tot.gross)], ['SsoExpense', 'debit', satOf(tot.ssoEmployer)], ['PitPayable', 'credit', satOf(tot.pit)],
      ['SsoPayable', 'credit', satOf(tot.sso) + satOf(tot.ssoEmployer)], ['SalaryPayable', 'credit', satOf(tot.net)], ['EmployeePayable', 'credit', slips.reduce((n, s) => n + satOf(s.otherDeduction), 0)]];
    if (!e) out.push(`${d.id}: no payroll journal entry`);
    else for (const [r, side, n] of want) if (role(r, side) !== n) out.push(`${d.id}: journal ${r} ${side} ${fromSatang(role(r, side))} but its slips say ${fromSatang(n)}`);
  }
  return out;
}
