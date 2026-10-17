import { docViewHref } from '@/descriptors';
import { LIVE } from '@/domain/doc-types';
import type { Actor, Doc, DocLine, DocOpening, DocTotals, EmployeeSnapshot, IsoDate, JournalEntryPreview, Lock, MissingItem, Money, PartySummary, PayItems, PayrollData, PayrollPayment, PayrollSlip, PayrollTables, PayrollTotals, PayslipLine } from '@/domain/types';
import type { MockState } from '../store';
import { PAYROLL_TABLES } from '../fixtures/payroll-tables';
import { bahtText } from './bahtText';
import type { RolePosting } from './ledger';
import { correctionReversal, dateGuards, placed, publicDoc } from './commands';
import { reconciliationLock } from './locks';
import { MockError, logActivity, logAudit, stamp } from './log';
import { resolveRole } from './posting';
import { formatDateBE } from '@/lib/format';
import { refuseInactiveBank } from '../records/bank-accounts';
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
  // A SECOND run in a month (a bonus, a correction) is taxed incrementally (m2: which run is "first" is decided by issue order, not by what it pays; later months true it up): PIT = tax(projection with this run) - tax(projection without it). The regular method divides the year's remaining tax by the
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
/** The slips of a run as the books give them now. Ruling 1 (PY1a): a later master or table edit never changes an issued slip, including through a revise. An employee who already has a slip on the run keeps their
 *  STORED employee snapshot and STORED tables: with the same pay items and the same chain (year to date, SSO of the month, earlier run of the month) the slip is kept verbatim, else it is recomputed from the stored
 *  snapshot with the new items / chain. Only an employee ADDED to the run takes the live master and the live tables. The exit for a master-data mistake on an issued run: cancel and re-issue (takes the live master),
 *  or adjust in the next run. [SP-R] m4: the work period is the pay-date month; Ham decides at GPY. */
export function buildRun(st: MockState, companyId: string, body: PrBody, selfId?: string): PayrollSlip[] {
  const self = selfId ? st.docs.find((d) => d.id === selfId && d.companyId === companyId) : undefined;
  const date = body.header.documentDate, month = date.slice(0, 7), kept = self?.payroll?.slips ?? [];
  const seen = new Set<string>(), out: PayrollSlip[] = [];
  for (const l of body.lines) {
    const p = employeeOf(st, companyId, l.employeeId);
    if (!p || seen.has(p.id)) continue;
    seen.add(p.id);
    const items = normItems(l.pay), old = kept.find((s) => s.employeeId === p.id), chain = chainFor(st, companyId, p.id, { date, number: self?.number, id: self?.id });
    if (old && old.month === month && JSON.stringify([old.items, old.prior, old.monthSso, old.sameMonthPrior]) === JSON.stringify([items, chain.prior, chain.monthSso, chain.sameMonthPrior])) out.push(old);
    else out.push(computeSlip({ employeeId: p.id, employee: old ? old.employee : snapshotOf(p), tables: old ? old.tables : structuredClone(PAYROLL_TABLES), items, month, ...chain }));
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
  refusePaid(st, d); // PY2 ruling 6: a paid run is refused here too (cancel, revise and the correction plan all come through this line); exit: unpay first
}
/** The same fact as a lock the document reads with (derived, never stored): the reason and its exits. */
export function payrollLock(st: MockState, ref: { id?: string; type?: string }): Lock | undefined {
  const d = ref.type === 'PR' && ref.id ? st.docs.find((x) => x.id === ref.id) : undefined;
  if (!d?.payroll) return undefined;
  const later = laterRuns(st, d.companyId, { id: d.id, date: d.header.documentDate, number: d.number }, d.payroll.slips.map((s) => s.employeeId));
  if (!later.length) return paidLock(st, d);
  const last = later[later.length - 1], href = docViewHref('PR', last.id);
  return { kind: 'payroll', reason: `มีรอบเงินเดือนที่ออกภายหลัง (${later.map((x) => x.number).join(', ')}) ที่มีพนักงานของรอบนี้ ยอดสะสมของพนักงานต่อเนื่องกัน`,
    exits: ['แก้ไขในรอบถัดไปด้วยรายการปรับปรุง (รายได้อื่น / รายการหักอื่น)', `ยกเลิกรอบถัดไป ${last.number} ก่อน`], ...(href ? { href } : {}) };
}

/** Everything that refuses a run before anything is written (issue, revise, compute): a later run in the books, and an other deduction larger than what is left of the pay (never a negative net). */
export function payrollProblem(st: MockState, companyId: string, type: string, body: PrBody, selfId?: string): MockError | undefined {
  if (type !== 'PR') return undefined;
  const self = selfId ? st.docs.find((d) => d.id === selfId) : undefined;
  if (self?.payroll && self.header.documentDate.slice(0, 7) !== body.header.documentDate.slice(0, 7)) return fail(422, 'payroll.month_fixed', 'เดือนของวันที่จ่ายของรอบที่ออกแล้วเปลี่ยนไม่ได้ (เดือนนี้คือเดือนที่ยื่นภาษีและประกันสังคม) เลื่อนวันที่ภายในเดือนเดิมได้ ทางออก: ยกเลิกรอบนี้แล้วออกรอบใหม่');
  const slips = buildRun(st, companyId, body, selfId);
  const later = laterRuns(st, companyId, { id: selfId, date: body.header.documentDate, number: self?.number }, slips.map((s) => s.employeeId));
  if (later.length) return fail(409, 'payroll.later_run', laterTitle(later));
  if (self) { const paid = paidError(st, self); if (paid) return paid; } // PY2 ruling 6: a paid run is not recomputed or revised (exit: unpay)
  for (const s of slips) {
    const room = satOf(s.gross) - satOf(s.pit) - satOf(s.sso);
    if (room < 0 && satOf(s.otherDeduction) === 0) return fail(422, 'payroll.pay_below_deductions', `${s.name}: เงินได้ของเดือนนี้ (${s.gross}) น้อยกว่าประกันสังคม (${s.sso}) จ่ายไม่ได้ (เงินเดือนตามสัดส่วนวันทำงานต่ำกว่าฐานขั้นต่ำของประกันสังคม) ทางออก: ตรวจวันเริ่มงาน / ลาออก หรือเงินเดือน หรือเพิ่มรายได้ของเดือนนี้`);
    if (satOf(s.otherDeduction) > room) return fail(422, 'payroll.deduction_exceeds', `รายการหักอื่นของ ${s.name} (${s.otherDeduction}) มากกว่าเงินที่เหลือหลังหักภาษีและประกันสังคม (${fromSatang(Math.max(0, room))}) ลดรายการหักอื่นลง`);
  }
  return undefined;
}

/** Ruling 2 (PY1a): an opening balance's payroll year to date is the start of the chain of every slip of its year. Issuing one (prev = none), revising its payroll year to date or its year, or cancelling it (next = none) is refused while a
 *  live run of that year has a slip for an employee in the old or the new list. Exit: cancel those runs first, latest first. A revise that leaves the year to date identical is untouched. */
export function obPayrollProblem(st: MockState, companyId: string, prev: Stored | undefined, next: { header: { documentDate: IsoDate }; opening?: DocOpening } | undefined): MockError | undefined {
  const side = (x?: { header: { documentDate: IsoDate }; opening?: DocOpening }) => ({ year: x?.header.documentDate.slice(0, 4) ?? '', rows: [...(x?.opening?.payrollYtd ?? [])].sort((a, b) => a.employeeId.localeCompare(b.employeeId)) });
  const a = side(prev), b = side(next);
  if (prev && next && a.year === b.year && JSON.stringify(a.rows) === JSON.stringify(b.rows)) return undefined;
  for (const x of [a, b]) {
    const ids = x.rows.map((r) => r.employeeId), runs = ids.length ? liveRuns(st, companyId).filter((d) => d.header.documentDate.slice(0, 4) === x.year && d.payroll!.slips.some((s) => ids.includes(s.employeeId))) : [];
    if (runs.length) return fail(409, 'payroll.ob_in_use', `ยอดยกมานี้มียอดเงินเดือนสะสมของพนักงานที่มีรอบเงินเดือนของปี ${x.year} อยู่ (${runs.map((d) => d.number).join(', ')}) ยอดสะสมของใบจ่ายเงินเดือนเหล่านั้นต่อเนื่องจากยอดนี้ จึงออกยอดยกมานี้ แก้ยอดสะสม หรือยกเลิกยอดยกมาไม่ได้ ทางออก: ยกเลิกรอบเงินเดือนเหล่านั้นก่อน (จากรอบล่าสุดย้อนขึ้นไป)`);
  }
  return undefined;
}

// ---------------------------------------------------------------- posting

/** The run's journal, exactly the frozen slips: salary and the employer's SSO as expense; PIT, SSO (both sides) and the net pay as payables; the other deductions (money withheld for someone else: กยศ., a court order, a fund, a loan repayment) on 2190, with no party: they are NOT owed to the employee. A PV / JV clears 2190 later [SP-R]. */
export const payrollRows = (d: { payroll?: PayrollData }): RolePosting => {
  const slips = d.payroll?.slips ?? [], sum = (k: 'gross' | 'pit' | 'sso' | 'ssoEmployer' | 'net' | 'otherDeduction') => slips.reduce((n, s) => n + satOf(s[k]), 0);
  return [['SalaryExpense', sum('gross'), 0], ['SsoExpense', sum('ssoEmployer'), 0], ['PitPayable', 0, sum('pit')], ['SsoPayable', 0, sum('sso') + sum('ssoEmployer')], ['SalaryPayable', 0, sum('net')],
    ['PayrollDeductionPayable', 0, sum('otherDeduction')]];
};

// ---------------------------------------------------------------- PY2: pay the run, unpay

/** The payment in force for a run (a reversed one is history). */
export const paymentOf = (st: MockState, runId: string): PayrollPayment | undefined => st.payrollPayments.find((p) => p.runId === runId && !p.reversed);
const paidWhere = (p: PayrollPayment) => `จ่ายเงินเดือนแล้ว วันที่ ${formatDateBE(p.date)} จาก ${p.account.accountName}`;
const UNPAY_EXIT = 'ยกเลิกการจ่าย (unpay) ก่อน แล้วจึงแก้ไขหรือยกเลิกรอบนี้';
/** Ruling 6: a paid run cannot be revised or cancelled; the exit is to unpay it first. */
export function paidError(st: MockState, d: Stored): MockError | undefined {
  const p = d.type === 'PR' ? paymentOf(st, d.id) : undefined;
  return p ? fail(409, 'payroll.paid', `${paidWhere(p)} แก้ไขหรือยกเลิกไม่ได้ ทางออก: ${UNPAY_EXIT}`) : undefined;
}
export function refusePaid(st: MockState, d: Stored): void { const e = paidError(st, d); if (e) throw e; }
const paidLock = (st: MockState, d: Stored): Lock | undefined => { const p = paymentOf(st, d.id); return p ? { kind: 'payroll', reason: paidWhere(p), exits: [UNPAY_EXIT] } : undefined; };

/** Ruling 3: the existing bank matcher takes a payment as it takes a payment voucher of the account (money out, the account's own lines, the same exact-amount / date suggestions). This is only the adapter it reads through - no second matcher:
 *  every payment (a reversed one is `cancelled`, so the matcher refuses it and invariant 13 names a match left on it) as a PV-shaped document, and its journal entries where the matcher expects a document's. */
export const payDocs = (st: MockState, companyId: string): Stored[] => st.payrollPayments.filter((p) => p.companyId === companyId).map((p) => {
  const run = st.docs.find((d) => d.id === p.runId), label = `จ่ายเงินเดือน ${run?.number ?? p.runId}`;
  return { id: p.id, companyId, type: 'PV', number: label, status: p.reversed ? 'cancelled' : 'issued', correctionClass: 'L', revision: 0, version: 1, lines: [], locks: [], createdBy: p.actor,
    header: { documentDate: p.date, bankAccountId: p.accountId, paymentMethod: 'transfer', reference: `เงินเดือน ${run?.header.reference ?? ''}`.trim() },
    totals: { gross: p.amount, discount: '0.00', net: p.amount, vat: '0.00', total: p.amount, cash: p.amount, amountInWords: bahtText(p.amount) } } as unknown as Stored;
});
export const payEntries = (st: MockState, paymentId: string): JournalEntryPreview[] | undefined => {
  const p = st.payrollPayments.find((x) => x.id === paymentId);
  return p && st.bankJournals.find((j) => j.id === p.journalId)?.entries;
};

export interface PayRunRequest { accountId?: string; date: IsoDate; version: number }
const nameOfAccount = (st: MockState, companyId: string, code: string) => st.accounts.find((a) => a.companyId === companyId && a.code === code)?.nameTh ?? code;
const ownRun = (st: MockState, companyId: string, runId: string): Stored => {
  const d = st.docs.find((x) => x.id === runId && x.type === 'PR' && x.companyId === companyId);
  if (!d) throw fail(404, 'doc.not_found', 'ไม่พบเอกสาร');
  return d;
};
const staleness = (d: Stored, v: number) => { if (d.version !== v) throw fail(409, 'doc.version_conflict', 'เอกสารถูกแก้ไขโดยผู้อื่นแล้ว กรุณาโหลดใหม่'); };
const payableCode = (st: MockState, companyId: string): string => { try { return resolveRole(st, 'SalaryPayable', { companyId, docType: 'PR' }).code; } catch { return '2170'; } };

/** Pay a run: the whole run only (ponytail: no partial pay - the money is Σ net of the frozen slips, and a partial payment would need a second source of truth for what is still owed; the exit for a wrong payment is unpay and pay again).
 *  Dr SalaryPayable (2170) / Cr the account, both for the run's STORED net; the account is frozen on the payment (name, number, bank, GL code) and the run becomes `settled` through a `settles` link whose `from` is the payment. Nothing here touches a slip. */
export function payRun(st: MockState, companyId: string, runId: string, req: PayRunRequest, actor: Actor): Doc {
  const d = ownRun(st, companyId, runId);
  if (d.status === 'settled' || paymentOf(st, d.id)) throw fail(409, 'payroll.already_paid', 'รอบนี้จ่ายเงินเดือนแล้ว ถ้าจ่ายผิดบัญชีหรือผิดวันที่ ให้ยกเลิกการจ่ายแล้วจ่ายใหม่');
  if (d.status !== 'issued' || !d.payroll) throw fail(409, 'payroll.not_issued', 'จ่ายเงินเดือนได้เฉพาะรอบที่ออกแล้วและยังไม่ถูกยกเลิก');
  staleness(d, req.version);
  const active = st.bankAccounts.filter((b) => b.companyId === companyId && b.active !== false);
  if (!req.accountId && active.length !== 1) throw fail(422, 'payroll.account_required', active.length ? 'ต้องเลือกบัญชีที่จ่ายเงินเดือน (accountId) เพราะบริษัทมีบัญชีธนาคาร/เงินสดที่ใช้งานอยู่มากกว่าหนึ่งบัญชี' : 'ไม่มีบัญชีธนาคารหรือเงินสดที่ใช้งานอยู่ (accountId) เปิดใช้งานบัญชีก่อนจ่ายเงินเดือน');
  const acct = req.accountId ? st.bankAccounts.find((b) => b.id === req.accountId && b.companyId === companyId) : active[0];
  if (!acct) throw fail(422, 'pay.invalid_bank_account', 'บัญชีธนาคารที่เลือกไม่ใช่ของบริษัทนี้');
  refuseInactiveBank(st, companyId, acct.id);
  const date = req.date;
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) throw fail(422, 'payroll.pay_date', 'วันที่จ่ายไม่ถูกต้อง (date)');
  if (date < d.header.documentDate) throw fail(422, 'payroll.pay_date', `วันที่จ่าย (${formatDateBE(date)}) ต้องไม่ก่อนวันที่ของรอบเงินเดือน (${formatDateBE(d.header.documentDate)})`);
  dateGuards(st, companyId, date);
  const amount = toSatang(d.totals.net);
  if (amount <= 0) throw fail(422, 'payroll.nothing_to_pay', 'รอบนี้ไม่มียอดเงินเดือนสุทธิที่ต้องจ่าย');

  // all judged - write
  const payable = resolveRole(st, 'SalaryPayable', { companyId, docType: 'PR' }), tag = `จ่ายเงินเดือน ${d.number ?? d.id}`;
  const leg = (code: string, debit: number, credit: number, rule: string) => ({ accountCode: code, accountName: nameOfAccount(st, companyId, code), debit: fromSatang(debit), credit: fromSatang(credit), rule });
  const e = placed(st, companyId, { date, kind: 'original', postedAt: stamp(), lines: [leg(payable.code, amount, 0, payable.rule), leg(acct.accountCode, 0, amount, `${tag}: Cash → ${acct.accountCode}`)] }); // line ORDER is the contract: the payable first, the bank last
  const journalId = `bj-${String(st.bankJournals.length + 1).padStart(3, '0')}`, id = `prp-${String(st.payrollPayments.length + 1).padStart(3, '0')}`;
  st.bankJournals.push({ id: journalId, companyId, accountId: acct.id, kind: 'payroll', label: tag, entries: [e] });
  st.payrollPayments.push({ id, companyId, runId, amount: d.totals.net, date, accountId: acct.id,
    account: { kind: acct.kind, ...(acct.bankName ? { bankName: acct.bankName } : {}), ...(acct.accountNo ? { accountNo: acct.accountNo } : {}), accountName: acct.nameTh, accountCode: acct.accountCode }, journalId, actor, at: stamp() });
  st.links.push({ companyId, from: id, to: runId, kind: 'settles', amount: d.totals.net, active: true });
  st.docs[st.docs.findIndex((x) => x.id === runId)] = { ...d, status: 'settled', version: d.version + 1 };
  logActivity(st, runId, actor, 'pay', `${tag} ${formatDateBE(date)} จาก ${acct.nameTh}`);
  logAudit(st, actor, companyId, 'doc.pay', runId, { status: 'issued' }, { status: 'settled', paymentId: id, accountId: acct.id, date, amount: d.totals.net });
  return publicDoc(st.docs.find((x) => x.id === runId)!);
}

/** Unpay = reverse with a reason. The reversal follows SP0 5.9 (its own date while that month is open, else late on the first open date; a closed year refuses); refused while the payment is matched to a bank line (exit: unmatch it first). */
export function unpayRun(st: MockState, companyId: string, runId: string, req: { reason: string; version: number }, actor: Actor): Doc {
  const d = ownRun(st, companyId, runId), p = paymentOf(st, d.id);
  if (!p || d.status !== 'settled') throw fail(409, 'payroll.not_paid', 'รอบนี้ยังไม่ได้จ่ายเงินเดือน');
  const why = (req.reason ?? '').trim();
  if (!why) throw fail(422, 'payroll.reason_required', 'ต้องระบุเหตุผลในการยกเลิกการจ่ายเงินเดือน (reason)');
  staleness(d, req.version);
  const lock = reconciliationLock(st, p.id);
  if (lock) throw fail(409, 'payroll.pay_reconciled', `${lock.reason} — ยกเลิกการจ่ายไม่ได้ ทางออก: ยกเลิกการจับคู่ที่รายการเดินบัญชีก่อน`);
  const j = st.bankJournals.find((x) => x.id === p.journalId)!, rev = correctionReversal(st, companyId, j.entries[0]); // judged (a closed year throws) before anything is written
  j.entries = [...j.entries, rev];
  p.reversed = { at: stamp(), by: actor, reason: why, date: rev.date };
  st.links = st.links.map((l) => (l.active && l.kind === 'settles' && l.from === p.id ? { ...l, active: false } : l));
  st.docs[st.docs.findIndex((x) => x.id === runId)] = { ...d, status: 'issued', version: d.version + 1 };
  logActivity(st, runId, actor, 'unpay', `ยกเลิกการจ่ายเงินเดือน ${formatDateBE(p.date)} เหตุผล: ${why}`);
  logAudit(st, actor, companyId, 'doc.unpay', runId, { status: 'settled', paymentId: p.id }, { status: 'issued', reason: why });
  return publicDoc(st.docs.find((x) => x.id === runId)!);
}

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
      // The WHOLE slip, key by key (PY1a ruling 3). Accepted residual: a field no figure depends on (employee.nationalId, tables.version) cannot be caught by a recompute; PY3 anchors them to the 50 ทวิ / ภ.ง.ด.1 snapshot.
      for (const k of new Set([...Object.keys(s), ...Object.keys(back)]) as Set<keyof PayrollSlip>) if (JSON.stringify(back[k]) !== JSON.stringify(s[k])) out.push(`${w}: ${k} ${JSON.stringify(s[k]) ?? 'none'} but its stored inputs give ${JSON.stringify(back[k]) ?? 'none'}`);
      if (satOf(s.net) !== satOf(s.gross) - satOf(s.pit) - satOf(s.sso) - satOf(s.otherDeduction)) out.push(`${w}: net ${s.net} is not gross ${s.gross} - PIT ${s.pit} - SSO ${s.sso} - other deduction ${s.otherDeduction}`);
      if (satOf(s.net) < 0) out.push(`${w}: negative net ${s.net}`);
      const chain = chainFor(st, d.companyId, s.employeeId, { id: d.id, date: d.header.documentDate, number: d.number });
      if (JSON.stringify([chain.prior, chain.monthSso, chain.sameMonthPrior]) !== JSON.stringify([s.prior, s.monthSso, s.sameMonthPrior])) out.push(`${w}: year to date ${JSON.stringify(s.prior)} (month SSO ${s.monthSso}) but the opening balance and the earlier slips give ${JSON.stringify(chain.prior)} (month SSO ${chain.monthSso})`);
    }
    if (satOf(d.totals.total) !== satOf(tot.net) || satOf(d.totals.net) !== satOf(tot.net) || satOf(d.totals.gross) !== satOf(tot.gross)) out.push(`${d.id}: totals ${d.totals.gross} / ${d.totals.total} but its slips give ${tot.gross} / ${tot.net}`);
    const e = st.journals.find((j) => j.docId === d.id)?.preview.entries.filter((x) => x.kind !== 'reversal').pop();
    const role = (r: string, side: 'debit' | 'credit') => (e?.lines ?? []).filter((l) => new RegExp(`: ${r} → `).test(l.rule)).reduce((n, l) => n + satOf(l[side]), 0);
    const want: [string, 'debit' | 'credit', number][] = [['SalaryExpense', 'debit', satOf(tot.gross)], ['SsoExpense', 'debit', satOf(tot.ssoEmployer)], ['PitPayable', 'credit', satOf(tot.pit)],
      ['SsoPayable', 'credit', satOf(tot.sso) + satOf(tot.ssoEmployer)], ['SalaryPayable', 'credit', satOf(tot.net)], ['PayrollDeductionPayable', 'credit', slips.reduce((n, s) => n + satOf(s.otherDeduction), 0)]];
    if (!e) out.push(`${d.id}: no payroll journal entry`);
    else for (const [r, side, n] of want) if (role(r, side) !== n) out.push(`${d.id}: journal ${r} ${side} ${fromSatang(role(r, side))} but its slips say ${fromSatang(n)}`);
  }
  out.push(...paymentInvariants(st));
  return out;
}

/** PY2 ruling 7: every payment is its run's stored net, posted exactly Dr SalaryPayable / Cr the account it FROZE (never the live account); a run is `settled` iff it has exactly one payment in force, joined by one active settles link;
 *  after pay the run's net contribution to GL 2170 is 0, after unpay it is Σ net again. (Dr = Cr of the journal is judged by the generic journal invariant: the payment's journal is a bank journal.) */
function paymentInvariants(st: MockState): string[] {
  const out: string[] = [], runs = st.docs.filter((d) => d.type === 'PR');
  for (const p of st.payrollPayments) {
    const w = `payroll payment ${p.id}`, d = runs.find((x) => x.id === p.runId), j = st.bankJournals.find((x) => x.id === p.journalId), e = j?.entries[0], last = j?.entries[j.entries.length - 1];
    if (!d || d.companyId !== p.companyId) { out.push(`${w}: its run ${p.runId} is missing or of another company`); continue; }
    if (!j || j.companyId !== p.companyId || j.kind !== 'payroll' || !e) { out.push(`${w}: no payroll journal ${p.journalId}`); continue; }
    const code = payableCode(st, p.companyId), want: [string, number, number][] = [[code, satOf(p.amount), 0], [p.account.accountCode, 0, satOf(p.amount)]];
    if (e.lines.length !== 2 || want.some(([c, dr, cr], i) => e.lines[i].accountCode !== c || satOf(e.lines[i].debit) !== dr || satOf(e.lines[i].credit) !== cr)) out.push(`${w}: journal is not Dr ${code} / Cr ${p.account.accountCode} for ${p.amount} (lines ${e.lines.map((l) => `${l.accountCode} ${l.debit}/${l.credit}`).join(', ')})`);
    if (j.accountId !== p.accountId) out.push(`${w}: journal is on account ${j.accountId} but the payment froze ${p.accountId}`);
    if (e.date !== p.date && !(e.late && e.date > p.date)) out.push(`${w}: journal entry date ${e.date} but the payment date is ${p.date} (only a late posting by the go-live floor or a closed month may be later)`); // m1: placed() floors to the bank go-live
    if (!!p.reversed !== (last?.kind === 'reversal')) out.push(`${w}: ${p.reversed ? 'reversed on the record but its journal is not' : 'journal reversed but the payment is not marked reversed'}`);
    const links = st.links.filter((l) => l.active && l.kind === 'settles' && l.from === p.id);
    if (p.reversed ? links.length !== 0 : links.length !== 1 || links[0].to !== p.runId || satOf(links[0].amount) !== satOf(p.amount)) out.push(`${w}: settles link ${p.reversed ? 'still active after unpay' : 'missing or not the payment amount to its run'}`);
    if (!p.reversed && satOf(p.amount) !== satOf(d.totals.net)) out.push(`${w}: amount ${p.amount} but the run's stored net is ${d.totals.net}`);
  }
  for (const d of runs) {
    const inForce = st.payrollPayments.filter((p) => p.runId === d.id && !p.reversed);
    if (inForce.length > 1) out.push(`${d.id}: ${inForce.length} payments in force (a run is paid once)`);
    if ((d.status === 'settled') !== (inForce.length === 1)) out.push(`${d.id}: status ${d.status} but ${inForce.length} payment(s) in force (settled iff exactly one)`);
    if (!d.payroll || !LIVE.includes(d.status)) continue;
    // the run's net contribution to GL 2170 (credit - debit): its own journal (issue, corrections) less what its payments took out
    const code = payableCode(st, d.companyId), net = (es: JournalEntryPreview[]) => es.reduce((n, x) => n + x.lines.filter((l) => l.accountCode === code).reduce((m, l) => m + satOf(l.credit) - satOf(l.debit), 0), 0);
    const mine = net(st.journals.find((x) => x.docId === d.id)?.preview.entries ?? []), paid = st.payrollPayments.filter((p) => p.runId === d.id).reduce((n, p) => n + net(st.bankJournals.find((x) => x.id === p.journalId)?.entries ?? []), 0);
    const want = inForce.length ? 0 : satOf(totalsOfSlips(d.payroll.slips).net);
    if (mine + paid !== want) out.push(`${d.id}: GL ${code} contribution is ${fromSatang(mine + paid)} but should be ${fromSatang(want)} (${inForce.length ? 'paid' : 'unpaid: Σ net'})`);
  }
  return out;
}
