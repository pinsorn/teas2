import { beforeEach, describe, expect, it } from 'vitest';
import type { Actor, DocLine } from '@/domain/types';
import { buildSeedState, type MockState } from '../store';
import { cancel, createDraft, issue, revise } from './commands';
import { checkInvariants } from './invariants';
import { reverseJv } from './journal';
import { derivedLocks } from './locks';
import type { MockError } from './log';
import { toSatang } from './money';
import { correctionPlan } from './corrections';
import { accountImpl } from '../records/accounts';
import { createAmortisation, createRecurring, liveRuns, planOf, runSchedule, scheduleInvariants, stopSchedule, updateSchedule } from './schedules';

const ME: Actor = { kind: 'user', id: 'u-1', name: 'สมศรี บัญชีดี' };
const CO = 'co-vat';
let st: MockState, n = 0;
beforeEach(() => { localStorage.clear(); st = buildSeedState(); });

const err = (fn: () => unknown): MockError => { try { fn(); } catch (e) { return e as MockError; } throw new Error('expected a refusal'); };
const doc = (id: string) => st.docs.find((d) => d.id === id)!;
const sched = (id: string) => st.schedules.find((s) => s.id === id)!;
const sat = (m: string) => toSatang(m);
const userReversalCount = (id: string) => st.docs.filter((d) => d.type === 'JV' && d.header.reversalOf === id).length;

/** An issued bill with one line on the prepaid account (category 'prepaid' -> 1150). */
const prepaidBill = (amount = '12000.00', date = '2026-07-01') => {
  const line: DocLine = { id: `pl-${++n}`, description: 'เบี้ยประกันอัคคีภัย', qty: '1', unit: 'ปี', unitPrice: amount, taxCode: 'EX', expenseCategory: 'prepaid' };
  const d = createDraft(st, CO, 'PB', { header: { documentDate: date, partyId: 'pv-02', vendorDocNumber: `INS-${n}`, vendorDocDate: date }, lines: [line] }, ME, `k${++n}`);
  return { bill: issue(st, d.id, d.version, ME), line };
};
const amort = (over: Record<string, unknown> = {}, bill = prepaidBill()) =>
  createAmortisation(st, CO, { name: 'ประกันอัคคีภัย', docId: bill.bill.id, lineId: bill.line.id, total: '12000.00', months: 12, startMonth: '2026-07', expenseAccount: '5120', ...over }, ME);
/** debit - credit (satang) of one account over the whole journal of the company. */
const netOf = (code: string, ids: string[]) => st.journals.filter((j) => ids.includes(j.docId)).flatMap((j) => j.preview.entries).flatMap((e) => e.lines).filter((l) => l.accountCode === code).reduce((a, l) => a + sat(l.debit) - sat(l.credit), 0);
const prepaidNet = (code: string) => st.journals.filter((j) => doc(j.docId)?.companyId === CO).flatMap((j) => j.preview.entries).flatMap((e) => e.lines).filter((l) => l.accountCode === code).reduce((a, l) => a + sat(l.debit) - sat(l.credit), 0);

describe('the plan (ruling 1)', () => {
  it('rounds months 1..n-1 and puts the residue in the last month; sums to the total exactly', () => {
    const p = planOf('10000.00', 3, '2026-07');
    expect(p).toEqual([{ month: '2026-07', amount: '3333.33' }, { month: '2026-08', amount: '3333.33' }, { month: '2026-09', amount: '3333.34' }]);
    expect(planOf('12000.00', 12, '2026-11').map((r) => r.month).slice(0, 3)).toEqual(['2026-11', '2026-12', '2027-01']); // across the year end
    for (const [t, m] of [['100.00', 7], ['0.07', 7], ['99999.99', 11], ['12000.00', 12]] as const) {
      const rows = planOf(t, m, '2026-01');
      expect(rows.reduce((a, r) => a + sat(r.amount), 0), `${t}/${m}`).toBe(sat(t));
    }
  });
  it('refuses a plan with a month of nothing (total too small for the months)', () => {
    expect(err(() => planOf('0.05', 12, '2026-07')).code).toBe('schedule.invalid');
  });
});

describe('creating an amortisation schedule (ruling 1)', () => {
  it('freezes total, months, start, both accounts and the plan table', () => {
    const s = amort();
    expect(s).toMatchObject({ kind: 'amortisation', total: '12000.00', months: 12, startMonth: '2026-07', expenseAccount: '5120', prepaidAccount: '1150', active: true, runs: [] });
    expect(s.plan).toHaveLength(12);
    expect(s.plan!.every((r) => r.amount === '1000.00')).toBe(true);
    expect(checkInvariants(st)).toEqual([]);
  });
  it('the source must be a PB / JV line on a prepaid account; total <= the line; one live schedule per line', () => {
    const rent = doc('pb-1');
    expect(err(() => createAmortisation(st, CO, { name: 'x', docId: rent.id, lineId: rent.lines[0].id, total: '1000.00', months: 2, startMonth: '2026-10', expenseAccount: '5120' }, ME)).code).toBe('schedule.source_invalid');
    const b = prepaidBill('12000.00');
    expect(err(() => amort({ total: '12000.01' }, b)).code).toBe('schedule.over_source');
    amort({ total: '6000.00', months: 6 }, b);
    expect(err(() => amort({}, b)).code).toBe('schedule.source_taken');
  });
  it('a stopped schedule frees its source line', () => {
    const b = prepaidBill();
    const s = amort({}, b);
    stopSchedule(st, CO, s.id, ME);
    expect(amort({}, b).id).not.toBe(s.id);
  });
  it('the expense account is postable, active, the company\'s, not controlled (same exit as a JV)', () => {
    const b = prepaidBill();
    expect(err(() => amort({ expenseAccount: '1130' }, b)).code).toBe('ledger.control_account');
    expect(err(() => amort({ expenseAccount: '5000' }, b)).code).toBe('ledger.account_invalid'); // a header account
    expect(err(() => amort({ expenseAccount: '9999' }, b)).code).toBe('ledger.account_invalid');
    st.accounts.find((a) => a.companyId === CO && a.code === '5120')!.active = false;
    expect(err(() => amort({}, b)).code).toBe('ledger.account_invalid');
    expect(st.schedules.filter((s) => s.kind === 'amortisation' && s.source?.docId === b.bill.id)).toHaveLength(0); // nothing written by the refusals
  });
  it('a JV line debiting the prepaid account is a source too', () => {
    const jl = (code: string, debit: string, credit: string): DocLine => ({ id: `jv-l-${++n}`, description: code, qty: '1', unit: '', unitPrice: '0.00', taxCode: 'EX', accountCode: code, debit, credit });
    const lines = [jl('1150', '6000.00', '0.00'), jl('2120', '0.00', '6000.00')];
    const d = createDraft(st, CO, 'JV', { header: { documentDate: '2026-10-01' }, lines }, ME, `k${++n}`);
    const jv = issue(st, d.id, d.version, ME);
    const s = createAmortisation(st, CO, { name: 'JV', docId: jv.id, lineId: lines[0].id, total: '6000.00', months: 3, startMonth: '2026-10', expenseAccount: '5120' }, ME);
    expect(s.plan!.map((r) => r.amount)).toEqual(['2000.00', '2000.00', '2000.00']);
    expect(err(() => createAmortisation(st, CO, { name: 'JV', docId: jv.id, lineId: lines[1].id, total: '10.00', months: 2, startMonth: '2026-10', expenseAccount: '5120' }, ME)).code).toBe('schedule.source_invalid');
  });
});

describe('running an amortisation (ruling 2)', () => {
  it('posts a system JV [expense Dr, prepaid Cr] dated the last day of the plan month, linked to the schedule', () => {
    const b = prepaidBill('10000.00');
    const s = amort({ total: '10000.00', months: 3 }, b);
    const before = prepaidNet('1150');
    const r = runSchedule(st, CO, s.id, ME);
    const run = r.runs[0], jv = doc(run.resultDocId!);
    expect(jv).toMatchObject({ type: 'JV', status: 'issued', header: { documentDate: '2026-07-31', scheduleId: s.id } });
    expect(jv.lines.map((l) => [l.accountCode, l.debit, l.credit])).toEqual([['5120', '3333.33', '0.00'], ['1150', '0.00', '3333.33']]);
    expect(jv.number).toMatch(/^JV-/);
    expect(st.journals.find((j) => j.docId === jv.id)!.preview.entries[0].lines.map((l) => [l.accountCode, l.debit, l.credit])).toEqual([['5120', '3333.33', '0.00'], ['1150', '0.00', '3333.33']]);
    expect(prepaidNet('1150') - before).toBe(-333333);
    expect(run).toMatchObject({ month: '2026-07', amount: '3333.33', at: '2026-07-31' });
    expect(checkInvariants(st)).toEqual([]);
  });
  it('runs go in plan order; the same month twice is refused; every run after the last is refused; after the last run the schedule is done', () => {
    const b = prepaidBill('10000.00');
    const s = amort({ total: '10000.00', months: 3 }, b);
    runSchedule(st, CO, s.id, ME);
    expect(err(() => runSchedule(st, CO, s.id, ME, { month: '2026-07' })).code).toBe('schedule.already_run');
    expect(err(() => runSchedule(st, CO, s.id, ME, { month: '2026-09' })).code).toBe('schedule.out_of_order');
    runSchedule(st, CO, s.id, ME);
    const last = runSchedule(st, CO, s.id, ME);
    expect(last.runs.map((r) => r.amount)).toEqual(['3333.33', '3333.33', '3333.34']);
    expect(last.active).toBe(false);
    expect(err(() => runSchedule(st, CO, s.id, ME)).code).toBe('schedule.done');
    // after all runs the schedule's contribution to GL(1150) is zero
    expect(netOf('1150', st.docs.filter((d) => d.header.scheduleId === s.id).map((d) => d.id))).toBe(-1000000);
    expect(netOf('1150', [b.bill.id])).toBe(1000000); // the bill put it there, the runs took it all out
    expect(checkInvariants(st)).toEqual([]);
  });
  it('a month after the current month is not due yet', () => {
    const b = prepaidBill('12000.00', '2026-10-01');
    const s = amort({ startMonth: '2026-12' }, b);
    const e = err(() => runSchedule(st, CO, s.id, ME));
    expect(e.code).toBe('schedule.not_due');
    expect(sched(s.id).runs).toHaveLength(0);
  });
  it('a closed month is refused (period.closed, exit: reopen) and nothing is written', () => {
    const b = prepaidBill();
    const s = amort({}, b);
    const p = st.periods.find((x) => x.companyId === CO && x.month === '2026-07')!; p.status = 'closed';
    const docs = st.docs.length, journals = st.journals.length;
    const e = err(() => runSchedule(st, CO, s.id, ME));
    expect(e.code).toBe('period.closed');
    expect(e.title).toContain('เปิดงวด');
    expect([st.docs.length, st.journals.length, sched(s.id).runs.length]).toEqual([docs, journals, 0]);
  });
  it('the run JV cannot be revised or cancelled directly (exit: กลับรายการ)', () => {
    const s = amort();
    const jv = doc(runSchedule(st, CO, s.id, ME).runs[0].resultDocId!);
    expect(err(() => cancel(st, jv.id, jv.version, 'OTHER', 'x', ME)).title).toContain('กลับรายการ');
    expect(err(() => revise(st, jv.id, { header: jv.header, lines: jv.lines }, jv.version, 'x', ME)).title).toContain('กลับรายการ');
    expect(derivedLocks(st, doc(jv.id)).some((l) => l.exits.includes('กลับรายการ'))).toBe(true);
  });
  it('reversing the last run JV marks the run reversed and the month runs again; only the latest run may be reversed', () => {
    const b = prepaidBill();
    const s = amort({}, b);
    const r1 = runSchedule(st, CO, s.id, ME).runs[0].resultDocId!;
    const r2 = runSchedule(st, CO, s.id, ME).runs[1].resultDocId!;
    const e = err(() => reverseJv(st, r1, ME));
    expect(e.code).toBe('schedule.run_not_last');
    expect(liveRuns(st, sched(s.id))).toHaveLength(2);
    reverseJv(st, r2, ME);
    expect(sched(s.id).runs[1].reversed).toBe(true);
    expect(liveRuns(st, sched(s.id))).toHaveLength(1);
    const again = runSchedule(st, CO, s.id, ME);
    expect(again.runs).toHaveLength(3);
    expect(again.runs[2]).toMatchObject({ month: '2026-08' });
    expect(checkInvariants(st)).toEqual([]);
  });
  it('reversing the last run of a done schedule brings it back to life', () => {
    const b = prepaidBill('2000.00');
    const s = amort({ total: '2000.00', months: 2 }, b);
    runSchedule(st, CO, s.id, ME);
    const last = runSchedule(st, CO, s.id, ME);
    expect(last.active).toBe(false);
    reverseJv(st, last.runs[1].resultDocId!, ME);
    expect(sched(s.id).active).toBe(true);
    expect(checkInvariants(st)).toEqual([]);
  });
  it('stop mid-way: audited, the rest stays on the prepaid account, no more runs', () => {
    const b = prepaidBill();
    const s = amort({}, b);
    runSchedule(st, CO, s.id, ME);
    const audits = st.audit.length;
    const stopped = stopSchedule(st, CO, s.id, ME, 'เลิกกรมธรรม์');
    expect(stopped).toMatchObject({ active: false, stopped: { reason: 'เลิกกรมธรรม์' } });
    expect(st.audit.slice(audits).some((a) => a.command === 'schedule.stop' && a.target === s.id)).toBe(true);
    expect(err(() => runSchedule(st, CO, s.id, ME)).code).toBe('schedule.stopped');
    expect(netOf('1150', [b.bill.id, ...st.docs.filter((d) => d.header.scheduleId === s.id).map((d) => d.id)])).toBe(1100000); // 11,000.00 stays on the prepaid account
    expect(checkInvariants(st)).toEqual([]);
  });
});

describe('the source lock (ruling 3)', () => {
  it('with a live run the source cannot be cancelled, nor its line money / account / date revised; other edits pass', () => {
    const b = prepaidBill();
    const s = amort({}, b);
    runSchedule(st, CO, s.id, ME);
    const d = doc(b.bill.id);
    const e = err(() => cancel(st, d.id, d.version, 'OTHER', 'x', ME));
    expect(e.code).toBe('schedule.source_locked');
    expect(e.title).toContain(`หยุดตารางตัดจ่าย ${s.name}`);
    const lock = derivedLocks(st, d).find((l) => l.kind === 'schedule')!;
    expect(lock.exits[0]).toBe(`หยุดตารางตัดจ่าย ${s.name}`);
    expect(lock.href).toBe(`/accounting/schedules/${s.id}`);
    const body = (over: (l: DocLine) => DocLine, headerOver = {}) => ({ header: { ...d.header, ...headerOver }, lines: d.lines.map(over) });
    for (const [what, b2] of [
      ['money', body((l) => ({ ...l, unitPrice: '11000.00' }))], ['account', body((l) => ({ ...l, expenseCategory: 'services' }))], ['date', body((l) => l, { documentDate: '2026-07-02' })],
    ] as const) expect(err(() => revise(st, d.id, b2, d.version, 'x', ME)).code, what).toBe('schedule.source_locked');
    expect(err(() => correctionPlan(st, d.id, body((l) => ({ ...l, unitPrice: '11000.00' })), 'accountant')).code).toBe('schedule.source_locked');
    const ok = revise(st, d.id, body((l) => ({ ...l, description: 'เบี้ยประกัน (แก้คำอธิบาย)' }), { notes: 'หมายเหตุ' }), d.version, 'x', ME);
    expect(ok.revision).toBe(1);
  });
  it('reversing the last run does not free the line: the schedule is not stopped; only the stop does (then the cancel is allowed)', () => {
    const b = prepaidBill();
    const s = amort({}, b);
    const jv = runSchedule(st, CO, s.id, ME).runs[0].resultDocId!;
    reverseJv(st, jv, ME);
    expect(derivedLocks(st, doc(b.bill.id)).some((l) => l.kind === 'schedule')).toBe(true);
    expect(err(() => cancel(st, b.bill.id, doc(b.bill.id).version, 'OTHER', 'ยกเลิก', ME)).code).toBe('schedule.source_locked');
    stopSchedule(st, CO, s.id, ME, 'x');
    expect(derivedLocks(st, doc(b.bill.id)).some((l) => l.kind === 'schedule')).toBe(false);
    cancel(st, b.bill.id, doc(b.bill.id).version, 'OTHER', 'ยกเลิก', ME);
    expect(checkInvariants(st)).toEqual([]);
  });
});

describe('a JV as the source (ruling 3)', () => {
  const jl = (code: string, debit: string, credit: string): DocLine => ({ id: `sj-${++n}`, description: code, qty: '1', unit: '', unitPrice: '0.00', taxCode: 'EX', accountCode: code, debit, credit });
  const srcJv = (header: Record<string, unknown> = {}) => {
    const lines = [jl('1150', '6000.00', '0.00'), jl('2120', '0.00', '6000.00')];
    const d = createDraft(st, CO, 'JV', { header: { documentDate: '2026-09-01', ...header }, lines }, ME, `k${++n}`);
    return { jv: issue(st, d.id, d.version, ME), line: lines[0] };
  };
  const make = (x: ReturnType<typeof srcJv>) => createAmortisation(st, CO, { name: 'JV', docId: x.jv.id, lineId: x.line.id, total: '6000.00', months: 3, startMonth: '2026-09', expenseAccount: '5120' }, ME);
  it('กลับรายการ of the source is refused while a run is live (as cancelling is), and allowed once every run is reversed - then it stops the schedule', () => {
    const x = srcJv(), s = make(x);
    const run = runSchedule(st, CO, s.id, ME).runs[0].resultDocId!;
    const e = err(() => reverseJv(st, x.jv.id, ME));
    expect(e.code).toBe('schedule.source_locked');
    expect(e.title).toContain(`หยุดตารางตัดจ่าย ${s.name}`);
    expect(userReversalCount(x.jv.id)).toBe(0);
    reverseJv(st, run, ME);
    expect(err(() => reverseJv(st, x.jv.id, ME)).code).toBe('schedule.source_locked'); // reversing the run does not free the line: the schedule must be stopped
    stopSchedule(st, CO, s.id, ME, 'x');
    reverseJv(st, x.jv.id, ME);
    expect(sched(s.id)).toMatchObject({ active: false, stopped: { reason: 'x' } });
    expect(checkInvariants(st)).toEqual([]);
  });
  it('a reversal, an auto-reversing accrual and a JV somebody reversed are not sources', () => {
    const acc = srcJv({ autoReverse: true });
    expect(err(() => make(acc)).code).toBe('schedule.source_invalid');
    const plain = srcJv();
    const rev = reverseJv(st, plain.jv.id, ME);
    expect(err(() => make(plain)).code).toBe('schedule.source_invalid'); // reversed
    expect(err(() => createAmortisation(st, CO, { name: 'x', docId: rev.id, lineId: rev.lines[1].id, total: '10.00', months: 2, startMonth: '2026-10', expenseAccount: '5120' }, ME)).code).toBe('schedule.source_invalid');
  });
  it('a run reversal is final: reversing it would re-post the month outside the books of the schedule', () => {
    const x = srcJv(), s = make(x);
    const run = runSchedule(st, CO, s.id, ME).runs[0].resultDocId!;
    const back = reverseJv(st, run, ME);
    const e = err(() => reverseJv(st, back.id, ME));
    expect(e.code).toBe('schedule.run_reversal_final');
    expect(e.title).toContain('รันงวดนั้นใหม่');
    runSchedule(st, CO, s.id, ME); // the way to re-post
    expect(checkInvariants(st)).toEqual([]);
  });
});

describe('recurring (ruling 4)', () => {
  const tpl = { type: 'TI' as const, header: { partyId: 'pc-04', documentDate: '2026-01-01' }, lines: [{ id: 'tl-1', description: 'ดูแลเว็บไซต์รายเดือน', qty: '1', unit: 'เดือน', unitPrice: '5000.00', taxCode: 'S7' as const }] };
  const rec = (over: Record<string, unknown> = {}) => createRecurring(st, CO, { name: 'ดูแลเว็บไซต์', frequency: 'monthly', nextRun: '2026-11-01', template: tpl, ...over }, ME);
  it('run now creates a DRAFT dated nextRun (never issues), advances nextRun, counts toward endAfter', () => {
    const s = rec({ endAfter: 2 });
    const r = runSchedule(st, CO, s.id, ME);
    const d = doc(r.runs[0].resultDocId!);
    expect(d).toMatchObject({ type: 'TI', status: 'draft', header: { documentDate: '2026-11-01', partyId: 'pc-04' } });
    expect(d.number).toBeUndefined();
    expect(st.journals.some((j) => j.docId === d.id)).toBe(false);
    expect(r.nextRun).toBe('2026-12-01');
    expect(r.active).toBe(true);
    const r2 = runSchedule(st, CO, s.id, ME);
    expect(r2).toMatchObject({ nextRun: '2027-01-01', active: false });
    expect(err(() => runSchedule(st, CO, s.id, ME)).code).toBe('schedule.done');
    expect(checkInvariants(st)).toEqual([]);
  });
  it('keeps the original day of month, clamped to the month end (31 Jan -> 28 Feb -> 31 Mar), and quarterly / yearly steps', () => {
    const s = rec({ nextRun: '2027-01-31' });
    expect(runSchedule(st, CO, s.id, ME).nextRun).toBe('2027-02-28');
    expect(runSchedule(st, CO, s.id, ME).nextRun).toBe('2027-03-31');
    const leap = rec({ nextRun: '2027-12-31', name: 'leap' });
    expect(runSchedule(st, CO, leap.id, ME).nextRun).toBe('2028-01-31');
    const q = rec({ nextRun: '2026-11-30', frequency: 'quarterly', name: 'q' });
    expect(runSchedule(st, CO, q.id, ME).nextRun).toBe('2027-02-28');
    const y = rec({ nextRun: '2028-02-29', frequency: 'yearly', name: 'y' });
    expect(runSchedule(st, CO, y.id, ME).nextRun).toBe('2029-02-28');
  });
  it('a closed nextRun month is refused', () => {
    const s = rec({ nextRun: '2026-05-01' });
    const e = err(() => runSchedule(st, CO, s.id, ME));
    expect(e.code).toBe('period.closed');
    expect(sched(s.id).runs).toHaveLength(0);
  });
  it('an inactive / gone party or item refuses the run with an exit naming the template editor; nothing is written', () => {
    const s = rec();
    const p = st.parties.find((x) => x.id === 'pc-04')!; p.active = false;
    const docs = st.docs.length;
    const e = err(() => runSchedule(st, CO, s.id, ME));
    expect(e.code).toBe('schedule.template_invalid');
    expect(e.title).toContain('แก้ไขแม่แบบ');
    expect(st.docs.length).toBe(docs);
    p.active = true;
    st.parties = st.parties.filter((x) => x.id !== 'pc-04');
    expect(err(() => runSchedule(st, CO, s.id, ME)).code).toBe('schedule.template_invalid');
  });
  it('a JV template obeys the JV rules at creation (no controlled accounts) and at run', () => {
    const jl = (code: string, debit: string, credit: string): DocLine => ({ id: `t-${++n}`, description: code, qty: '1', unit: '', unitPrice: '0.00', taxCode: 'EX', accountCode: code, debit, credit });
    expect(err(() => rec({ template: { type: 'JV', header: { documentDate: '2026-01-01' }, lines: [jl('1130', '10.00', '0.00'), jl('2120', '0.00', '10.00')] } })).code).toBe('ledger.control_account');
    const s = rec({ template: { type: 'JV', header: { documentDate: '2026-01-01', reference: 'ค้างจ่าย' }, lines: [jl('5120', '8000.00', '0.00'), jl('2120', '0.00', '8000.00')] } });
    st.accounts.find((a) => a.companyId === CO && a.code === '5120')!.active = false;
    expect(err(() => runSchedule(st, CO, s.id, ME)).code).toBe('ledger.account_invalid');
  });
  it('a template of a type the company cannot use is refused (TI in a non-VAT company)', () => {
    expect(err(() => createRecurring(st, 'co-nonvat', { name: 'x', frequency: 'monthly', nextRun: '2026-11-01', template: tpl }, ME)).code).toBe('doc.type_not_available');
  });
  it('the template is a frozen copy: editing the source document later changes nothing; edit keeps the version rule', () => {
    const src = st.docs.find((d) => d.type === 'TI' && d.status === 'issued' && d.companyId === CO)!;
    const s = createRecurring(st, CO, { name: 'จากเอกสาร', frequency: 'monthly', nextRun: '2026-11-15', docId: src.id }, ME);
    expect(s.template!.type).toBe('TI');
    expect(s.template!.lines).toEqual(src.lines.map((l) => { const { sourceLineId: _s, ...r } = l; void _s; return r; }));
    expect('documentDate' in s.template!.header).toBe(false);
    expect(s.source?.docId).toBe(src.id);
    const v0 = s.version;
    const upd = updateSchedule(st, CO, s.id, { name: 'ใหม่', frequency: 'quarterly', nextRun: '2026-12-10', endAfter: 4 });
    expect(upd).toMatchObject({ name: 'ใหม่', frequency: 'quarterly', nextRun: '2026-12-10', endAfter: 4, version: v0 + 1 });
  });
});

describe('invariants fail on a tampered state (ruling 5)', () => {
  const setup = () => { const b = prepaidBill('10000.00'); const s = amort({ total: '10000.00', months: 3 }, b); runSchedule(st, CO, s.id, ME); runSchedule(st, CO, s.id, ME); return { s: sched(s.id), b }; };
  it('holds on the untouched state', () => { setup(); expect(scheduleInvariants(st)).toEqual([]); });
  it('plan not summing to the total', () => { const { s } = setup(); s.plan![2].amount = '3333.35'; expect(scheduleInvariants(st).join('|')).toContain('plan'); });
  it('a run JV that no longer matches its plan row (amount)', () => {
    const { s } = setup(); const jv = doc(s.runs[0].resultDocId!);
    jv.lines[0].debit = '3333.34'; jv.lines[1].credit = '3333.34';
    expect(scheduleInvariants(st).join('|')).toContain(jv.id);
  });
  it('a run JV on the wrong date', () => { const { s } = setup(); doc(s.runs[0].resultDocId!).header.documentDate = '2026-07-30'; expect(scheduleInvariants(st).join('|')).toContain('date'); });
  it('a run JV not linked to its schedule', () => { const { s } = setup(); delete doc(s.runs[0].resultDocId!).header.scheduleId; expect(scheduleInvariants(st).length).toBeGreaterThan(0); });
  it('two live runs of one plan month', () => {
    const { s } = setup(); const jv = doc(s.runs[1].resultDocId!);
    s.runs[1].month = '2026-07'; jv.header.scheduleMonth = '2026-07'; jv.header.documentDate = '2026-07-31'; // each run alone is consistent with the July row; together they are one month twice
    expect(scheduleInvariants(st).join('|')).toContain('two live runs for plan month 2026-07');
  });
  it('runs that are not a prefix of the plan', () => { const { s } = setup(); s.runs.shift(); expect(scheduleInvariants(st).join('|')).toContain('prefix'); });
  it('a journal that moved the prepaid account differently from the runs', () => {
    const { s } = setup(); const e = st.journals.find((j) => j.docId === s.runs[0].resultDocId)!.preview.entries[0]; e.lines.find((l) => l.accountCode === '1150')!.credit = '3000.00'; e.lines.find((l) => l.accountCode === '5120')!.debit = '3000.00';
    expect(scheduleInvariants(st).join('|')).toContain('1150');
  });
  it('a schedule marked done with months not run', () => { const { s } = setup(); s.active = false; expect(scheduleInvariants(st).join('|')).toContain('done'); });
  it('a source cancelled under a live run', () => { const { b } = setup(); doc(b.bill.id).status = 'cancelled'; expect(scheduleInvariants(st).join('|')).toContain('source'); });
  it('a source JV reversed under a live run', () => {
    const { s } = setup(); void s;
    const jl = (code: string, debit: string, credit: string): DocLine => ({ id: `tj-${++n}`, description: code, qty: '1', unit: '', unitPrice: '0.00', taxCode: 'EX', accountCode: code, debit, credit });
    const lines = [jl('1150', '6000.00', '0.00'), jl('2120', '0.00', '6000.00')];
    const d = createDraft(st, CO, 'JV', { header: { documentDate: '2026-09-01' }, lines }, ME, `k${++n}`), jv = issue(st, d.id, d.version, ME);
    const sc = createAmortisation(st, CO, { name: 'JV', docId: jv.id, lineId: lines[0].id, total: '6000.00', months: 3, startMonth: '2026-09', expenseAccount: '5120' }, ME);
    runSchedule(st, CO, sc.id, ME);
    st.docs.push({ ...structuredClone(doc(jv.id)), id: 'fake-rev', number: 'JV-X', header: { documentDate: '2026-10-02', reversalOf: jv.id } }); // a reversal that got past the lock
    expect(scheduleInvariants(st).join('|')).toContain('source JV');
  });
  it('two live schedules on one source line', () => { const { s, b } = setup(); st.schedules.push({ ...structuredClone(s), id: 'dup', runs: [] }); void b; expect(scheduleInvariants(st).join('|')).toContain('source'); });
});

describe('the seed', () => {
  it('has the named schedules: recurring TI / JV (VAT), amortisation 12,000.00 x 12 from 2026-07 with 3 runs, recurring IV (non-VAT); invariants hold', () => {
    const am = sched('sch-amort');
    expect(am).toMatchObject({ kind: 'amortisation', total: '12000.00', months: 12, startMonth: '2026-07', companyId: CO, active: true });
    expect(liveRuns(st, am)).toHaveLength(3);
    expect(am.nextRun).toBe('2026-10-31');
    expect(sched('sch-rec-ti')).toMatchObject({ kind: 'recurring', frequency: 'monthly', nextRun: '2026-11-01', template: { type: 'TI', header: { partyId: 'pc-04' } } });
    expect(sched('sch-rec-ti').template!.lines[0].description).toBe('ดูแลเว็บไซต์รายเดือน');
    expect(sched('sch-rec-jv').template!.type).toBe('JV');
    expect(sched('nsch-rec-iv')).toMatchObject({ companyId: 'co-nonvat', template: { type: 'IV' } });
    expect(checkInvariants(st)).toEqual([]);
  });
});

// ---------------------------------------------------------------- AC4 fix round 1: source capacity is an invariant (S1-S3), no future runs (R-FUT), scheduled accounts stay
describe('source capacity (fix1: S1 notes, S2 stop + re-schedule, S3 no-run revise)', () => {
  const note = (b: ReturnType<typeof prepaidBill>, type: 'PCN' | 'PDN', amount: string) =>
    createDraft(st, CO, type, { header: { documentDate: '2026-10-14', refDocId: b.bill.id, reasonCode: type === 'PCN' ? 'PRICE_REDUCTION' : 'PRICE_INCREASE' }, lines: [{ id: `nl-${++n}`, description: 'ปรับเบี้ย', qty: '1', unit: 'u', unitPrice: amount, taxCode: 'EX', expenseCategory: 'prepaid', sourceLineId: b.line.id }] }, ME, `k${++n}`);
  const issueNote = (b: ReturnType<typeof prepaidBill>, type: 'PCN' | 'PDN', amount: string) => { const d = note(b, type, amount); return issue(st, d.id, d.version, ME); };
  const runs = (id: string, k: number) => { for (let i = 0; i < k; i++) runSchedule(st, CO, id, ME); };
  const reviseLine = (b: ReturnType<typeof prepaidBill>, over: Partial<DocLine>) => { const d = doc(b.bill.id); return revise(st, d.id, { header: d.header, lines: d.lines.map((l) => ({ ...l, ...over })) }, d.version, 'x', ME); };

  it('S1: a PCN / PDN on a line of a non-stopped schedule is refused, with or without a run (exit: stop the schedule)', () => {
    const b = prepaidBill(); const s = amort({}, b);
    for (const k of [0, 1]) {
      if (k) runSchedule(st, CO, s.id, ME);
      for (const [type, amt] of [['PCN', '12000.00'], ['PCN', '500.00'], ['PDN', '500.00']] as const) {
        const nd = note(b, type, amt);
        const e = err(() => issue(st, nd.id, nd.version, ME));
        expect(e.code, `${type} ${amt} runs=${k}`).toBe('schedule.source_locked');
        expect(e.title).toContain(`หยุดตารางตัดจ่าย ${s.name}`);
      }
    }
    expect(checkInvariants(st)).toEqual([]);
  });
  it('S1: after stop, a PCN may take the line down only to what the live runs consumed (schedule.source_consumed, exit: reverse the runs)', () => {
    const b = prepaidBill(); const s = amort({}, b);
    runs(s.id, 3); stopSchedule(st, CO, s.id, ME, 'x');
    const nd = note(b, 'PCN', '9500.00');
    expect(err(() => issue(st, nd.id, nd.version, ME)).code).toBe('schedule.source_consumed');
    issueNote(b, 'PCN', '9000.00');
    expect(checkInvariants(st)).toEqual([]);
  });
  it('S1: an existing PCN counts against the capacity at creation, and cannot be cancelled under a live schedule', () => {
    const b = prepaidBill(); const p = issueNote(b, 'PCN', '2000.00');
    expect(err(() => amort({ total: '10001.00' }, b)).code).toBe('schedule.over_source');
    const s = amort({ total: '10000.00' }, b);
    expect(err(() => cancel(st, p.id, doc(p.id).version, 'OTHER', 'x', ME)).code).toBe('schedule.source_locked');
    runs(s.id, 3); stopSchedule(st, CO, s.id, ME, 'x');
    cancel(st, p.id, doc(p.id).version, 'OTHER', 'x', ME); // capacity 12000 again, 2500 consumed
    expect(checkInvariants(st)).toEqual([]);
  });
  it('S2: stopped schedules keep their runs on the line: a new schedule may take only what is left', () => {
    const b = prepaidBill(); const s1 = amort({}, b);
    runs(s1.id, 3); stopSchedule(st, CO, s1.id, ME, 'x');
    expect(err(() => amort({ total: '12000.00', startMonth: '2026-10' }, b)).code).toBe('schedule.over_source');
    const s2 = amort({ total: '9000.00', startMonth: '2026-10' }, b);
    expect(s2.total).toBe('9000.00');
    expect(checkInvariants(st)).toEqual([]);
  });
  it('S3: with a schedule that has not run yet, the line money / account cannot be revised, planned or cancelled (exit: stop the schedule); after stop it can', () => {
    const b = prepaidBill(); const s = amort({}, b);
    for (const over of [{ unitPrice: '1000.00' }, { expenseCategory: 'services' }]) expect(err(() => reviseLine(b, over)).code).toBe('schedule.source_locked');
    const d = doc(b.bill.id);
    expect(err(() => correctionPlan(st, d.id, { header: d.header, lines: d.lines.map((l) => ({ ...l, unitPrice: '500.00' })) }, 'accountant')).code).toBe('schedule.source_locked');
    expect(err(() => revise(st, d.id, { header: { ...d.header, documentDate: '2026-07-02' }, lines: d.lines }, d.version, 'x', ME)).code).toBe('schedule.source_locked');
    expect(err(() => cancel(st, d.id, d.version, 'OTHER', 'x', ME)).code).toBe('schedule.source_locked');
    expect(derivedLocks(st, d).find((l) => l.kind === 'schedule')?.href).toBe(`/accounting/schedules/${s.id}`);
    stopSchedule(st, CO, s.id, ME, 'x');
    expect(reviseLine(b, { unitPrice: '1000.00' }).revision).toBe(1);
    expect(checkInvariants(st)).toEqual([]);
  });
  it('S3: after stop with runs, a revise may reduce the line only down to the live runs (source_consumed); a cancel is refused', () => {
    const b = prepaidBill(); const s = amort({}, b);
    runs(s.id, 3); stopSchedule(st, CO, s.id, ME, 'x');
    expect(err(() => reviseLine(b, { unitPrice: '2900.00' })).code).toBe('schedule.source_consumed');
    expect(err(() => reviseLine(b, { expenseCategory: 'services' })).code).toBe('schedule.source_consumed');
    const d = doc(b.bill.id);
    expect(err(() => cancel(st, d.id, d.version, 'OTHER', 'x', ME)).code).toBe('schedule.source_consumed');
    expect(reviseLine(b, { unitPrice: '3000.00' }).revision).toBe(1);
    expect(checkInvariants(st)).toEqual([]);
  });
  it('S3: a JV source with an unrun schedule cannot be reversed', () => {
    const lines = [{ id: `fj-${++n}`, description: 'p', qty: '1', unit: '', unitPrice: '0.00', taxCode: 'EX', accountCode: '1150', debit: '6000.00', credit: '0.00' }, { id: `fj-${++n}`, description: 'c', qty: '1', unit: '', unitPrice: '0.00', taxCode: 'EX', accountCode: '2120', debit: '0.00', credit: '6000.00' }] as DocLine[];
    const d = createDraft(st, CO, 'JV', { header: { documentDate: '2026-10-01' }, lines }, ME, `k${++n}`), jv = issue(st, d.id, d.version, ME);
    const s = createAmortisation(st, CO, { name: 'JV', docId: jv.id, lineId: lines[0].id, total: '6000.00', months: 3, startMonth: '2026-10', expenseAccount: '5120' }, ME);
    expect(err(() => reverseJv(st, jv.id, ME)).code).toBe('schedule.source_locked');
    stopSchedule(st, CO, s.id, ME, 'x');
    reverseJv(st, jv.id, ME);
    expect(checkInvariants(st)).toEqual([]);
  });
  it('invariant (single fault): sum of live runs on a line <= what the line holds - a line cut under the runs, a PCN grown after the fact', () => {
    let b = prepaidBill(); let s = amort({}, b); runs(s.id, 3);
    doc(b.bill.id).lines[0].unitPrice = '1000.00';
    expect(checkInvariants(st).join('|')).toContain('holds only');
    st = buildSeedState(); b = prepaidBill(); const p = issueNote(b, 'PCN', '2000.00'); s = amort({ total: '10000.00' }, b); runs(s.id, 3);
    expect(checkInvariants(st)).toEqual([]);
    doc(p.id).lines[0].unitPrice = '12000.00';
    expect(checkInvariants(st).join('|')).toContain('holds only');
  });
  it('invariant (single fault): totals of live schedules + runs of stopped ones <= what the line holds', () => {
    const b = prepaidBill(); const s1 = amort({}, b); runs(s1.id, 3); stopSchedule(st, CO, s1.id, ME, 'x');
    const s2 = amort({ total: '9000.00', startMonth: '2026-10' }, b);
    expect(checkInvariants(st)).toEqual([]);
    s2.total = '9600.00'; s2.plan = planOf('9600.00', 12, '2026-10'); // a schedule re-derived beyond the line
    expect(checkInvariants(st).join('|')).toContain('holds only');
  });
});

describe('no future-dated runs (fix1: R-FUT)', () => {
  it('a run is refused until its month has ended (today 2026-10-14): September runs, October is not due', () => {
    const b = prepaidBill('12000.00', '2026-09-01'); const s = amort({ startMonth: '2026-09' }, b);
    const jv = runSchedule(st, CO, s.id, ME).runs[0].resultDocId!;
    expect(doc(jv).header.documentDate).toBe('2026-09-30');
    const docs = st.docs.length;
    expect(err(() => runSchedule(st, CO, s.id, ME)).code).toBe('schedule.not_due');
    expect(st.docs).toHaveLength(docs);
  });
  it('the reversal of a run follows the plain reversal date rules: today or earlier, never ahead', () => {
    const s = amort({});
    const jv = runSchedule(st, CO, s.id, ME).runs[0].resultDocId!;
    expect(err(() => reverseJv(st, jv, ME, { date: '2026-10-31' })).code).toBe('doc.future_date');
    expect(reverseJv(st, jv, ME).header.documentDate <= '2026-10-14').toBe(true);
  });
});

describe('a scheduled account stays (fix1: ruling 3)', () => {
  const code = (c: string): string | undefined => { try { accountImpl.canDeactivate!(st, CO, c); } catch (e) { return (e as MockError).code; } return undefined; };
  it('the expense / prepaid account of a non-stopped schedule cannot be deactivated (account.scheduled, exit names the schedule); after stop it is judged as before', () => {
    stopSchedule(st, CO, 'sch-amort', ME, 'x'); // the seed's own schedule also holds these accounts
    const s = amort({});
    for (const c of ['5120', '1150']) {
      expect(code(c), c).toBe('account.scheduled');
      expect(err(() => accountImpl.canDeactivate!(st, CO, c)).title).toContain(s.name);
    }
    stopSchedule(st, CO, s.id, ME, 'x');
    expect(code('5120')).not.toBe('account.scheduled');
  });
});

// ---------------------------------------------------------------- AC4 fix round 2: F1 start before the source, F1b date lock once runs exist, done = released for the money lock
describe('source date (fix2: F1, F1b)', () => {
  const reviseDate = (b: ReturnType<typeof prepaidBill>, date: string) => { const d = doc(b.bill.id); return revise(st, d.id, { header: { ...d.header, documentDate: date, vendorDocDate: date, claimPeriod: date.slice(0, 7) }, lines: d.lines }, d.version, 'x', ME); };
  it('F1: a schedule cannot start before the month of its source document', () => {
    const b = prepaidBill('12000.00', '2026-09-01');
    expect(err(() => amort({ startMonth: '2026-07' }, b)).code).toBe('schedule.before_source');
    expect(amort({ startMonth: '2026-09' }, b).startMonth).toBe('2026-09');
  });
  it('F1b: with any live run on the line the source date cannot move, whatever the schedule state (exit: reverse the runs)', () => {
    const b = prepaidBill(); const s = amort({}, b); runSchedule(st, CO, s.id, ME);
    expect(err(() => reviseDate(b, '2026-08-15')).code).toBe('schedule.source_locked'); // live
    stopSchedule(st, CO, s.id, ME, 'x');
    const e = err(() => reviseDate(b, '2026-08-15')); // stopped
    expect(e.code).toBe('schedule.source_consumed');
    expect(e.title).toContain('กลับรายการ');
    expect(checkInvariants(st)).toEqual([]);
  });
  it('F1b: a done schedule keeps the date lock', () => {
    const b = prepaidBill('3000.00'); const s = amort({ total: '3000.00', months: 3 }, b); runSchedule(st, CO, s.id, ME); runSchedule(st, CO, s.id, ME); runSchedule(st, CO, s.id, ME);
    expect(sched(s.id).active).toBe(false);
    expect(err(() => reviseDate(b, '2026-08-15')).code).toBe('schedule.source_consumed');
  });
  it('invariant (single fault): every live run is dated on or after its source document', () => {
    const b = prepaidBill(); const s = amort({}, b); runSchedule(st, CO, s.id, ME);
    expect(checkInvariants(st)).toEqual([]);
    doc(b.bill.id).header.documentDate = '2026-08-15';
    expect(checkInvariants(st).join('|')).toContain('precedes its source');
  });
});

describe('done = released for the source lock (fix2)', () => {
  const lineRevise = (b: ReturnType<typeof prepaidBill>, price: string) => { const d = doc(b.bill.id); return revise(st, d.id, { header: d.header, lines: d.lines.map((l) => ({ ...l, unitPrice: price })) }, d.version, 'x', ME); };
  it('a done schedule no longer locks money / cancel, but the line cannot go below the runs; a PCN too; no lock banner', () => {
    const b = prepaidBill(); const s = amort({ total: '3000.00', months: 3 }, b);
    for (let i = 0; i < 3; i++) runSchedule(st, CO, s.id, ME);
    expect(sched(s.id)).toMatchObject({ active: false });
    expect(sched(s.id).stopped).toBeUndefined();
    expect(derivedLocks(st, doc(b.bill.id)).some((l) => l.kind === 'schedule')).toBe(false);
    expect(err(() => lineRevise(b, '2900.00')).code).toBe('schedule.source_consumed');
    expect(err(() => cancel(st, b.bill.id, doc(b.bill.id).version, 'OTHER', 'x', ME)).code).toBe('schedule.source_consumed');
    expect(lineRevise(b, '5000.00').revision).toBe(1);
    expect(checkInvariants(st)).toEqual([]);
  });
  it('the account guard stays on not-stopped: a done schedule still guards its accounts', () => {
    stopSchedule(st, CO, 'sch-amort', ME, 'x');
    const b = prepaidBill(); const s = amort({ total: '3000.00', months: 3 }, b);
    for (let i = 0; i < 3; i++) runSchedule(st, CO, s.id, ME);
    let c: string | undefined; try { accountImpl.canDeactivate!(st, CO, '5120'); } catch (e) { c = (e as MockError).code; }
    expect(c).toBe('account.scheduled');
  });
});

describe('AC7b: a recurring schedule template is edited as a whole (rulings 2-4)', () => {
  const tl = (over: Partial<DocLine> = {}): DocLine => ({ id: `tx-${++n}`, description: 'ดูแลเว็บไซต์รายเดือน', qty: '1', unit: 'เดือน', unitPrice: '5000.00', taxCode: 'S7', ...over });
  const rec = () => createRecurring(st, CO, { name: 'ดูแลเว็บไซต์', frequency: 'monthly', nextRun: '2026-11-01', template: { type: 'TI', header: { partyId: 'pc-04', documentDate: '2026-01-01' }, lines: [tl()] } }, ME);
  const body = (over: Record<string, unknown> = {}, lines: DocLine[] = [tl({ description: 'ดูแลเว็บไซต์ + โฆษณา', unitPrice: '7500.00' })]) => ({ template: { header: { partyId: 'pc-04', reference: 'PO-77', notes: 'หมายเหตุใหม่', ...over }, lines } });

  it('re-freezes the edited header and lines, keeps the previous template in a history (who / when), and a run makes a draft with the edited line', () => {
    const s = rec(), old = structuredClone(s.template!), v0 = s.version;
    const first = runSchedule(st, CO, s.id, ME).runs[0].resultDocId!; // a draft made before the edit
    const upd = updateSchedule(st, CO, s.id, body(), ME);
    expect(upd.version).toBeGreaterThan(v0);
    expect(upd.template!.header).toEqual({ partyId: 'pc-04', reference: 'PO-77', notes: 'หมายเหตุใหม่' });
    expect(upd.template!.lines.map((l) => [l.description, l.unitPrice])).toEqual([['ดูแลเว็บไซต์ + โฆษณา', '7500.00']]);
    expect(upd.template!.partyName).toBe(st.parties.find((p) => p.id === 'pc-04')!.name);
    expect(upd.templateHistory).toHaveLength(1);
    expect(upd.templateHistory![0]).toMatchObject({ by: ME, template: old });
    expect(upd.templateHistory![0].at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(upd.source).toBeUndefined(); // no longer a copy of a document
    expect(st.audit.some((a) => a.command === 'schedule.template' && a.target === s.id)).toBe(true);
    const second = runSchedule(st, CO, s.id, ME).runs[1].resultDocId!;
    expect(doc(second).lines.map((l) => l.unitPrice)).toEqual(['7500.00']);
    expect(doc(second).header).toMatchObject({ reference: 'PO-77', documentDate: '2026-12-01' });
    expect(doc(first).lines.map((l) => l.unitPrice)).toEqual(['5000.00']); // a draft already made is untouched
    expect(checkInvariants(st)).toEqual([]);
  });
  it('never takes dates, numbers or server-owned fields from the body', () => {
    const s = rec();
    const upd = updateSchedule(st, CO, s.id, body({ documentDate: '2020-01-01', dueDate: '2020-02-01', vendorDocNumber: 'X', scheduleId: 'sch-x', disposal: {} }), ME);
    expect(Object.keys(upd.template!.header).sort()).toEqual(['notes', 'partyId', 'reference']);
  });
  it('is refused like a draft that cannot be issued (same checks as creation); a refusal writes nothing', () => {
    const s = rec(), before = JSON.stringify(sched(s.id));
    expect(err(() => updateSchedule(st, CO, s.id, body({}, []), ME)).code).toBe('doc.incomplete');
    expect(err(() => updateSchedule(st, CO, s.id, body({ partyId: undefined }), ME)).code).toBe('doc.incomplete');
    expect(err(() => updateSchedule(st, CO, s.id, body({ partyId: 'nope' }), ME)).code).toBe('doc.incomplete');
    st.parties.find((p) => p.id === 'pc-01')!.active = false;
    expect(err(() => updateSchedule(st, CO, s.id, body({ partyId: 'pc-01' }), ME)).code).toBe('schedule.template_invalid');
    expect(err(() => updateSchedule(st, CO, s.id, body({}, [tl({ itemId: 'no-such-item' })]), ME)).code).toBe('schedule.template_invalid');
    expect(JSON.stringify(sched(s.id))).toBe(before);
  });
  it('a JV template keeps the JV rules (no controlled account)', () => {
    const jl = (code: string, debit: string, credit: string): DocLine => ({ id: `t-${++n}`, description: code, qty: '1', unit: '', unitPrice: '0.00', taxCode: 'EX', accountCode: code, debit, credit });
    const s = createRecurring(st, CO, { name: 'jv', frequency: 'monthly', nextRun: '2026-11-30', template: { type: 'JV', header: { documentDate: '2026-01-01' }, lines: [jl('5120', '8000.00', '0.00'), jl('2120', '0.00', '8000.00')] } }, ME);
    expect(err(() => updateSchedule(st, CO, s.id, { template: { header: {}, lines: [jl('1130', '10.00', '0.00'), jl('2120', '0.00', '10.00')] } }, ME)).code).toBe('ledger.control_account');
    expect(updateSchedule(st, CO, s.id, { template: { header: { reference: 'ใหม่', autoReverse: true }, lines: [jl('5120', '9000.00', '0.00'), jl('2120', '0.00', '9000.00')] } }, ME).template!.header).toEqual({ reference: 'ใหม่', autoReverse: true });
  });
  it('freezes the expense category of a purchase line at this save (a later item change does not move it)', () => {
    const item = st.items.find((i) => i.companyId === CO && i.expenseCategory && i.active !== false)!;
    const s = createRecurring(st, CO, { name: 'pb', frequency: 'monthly', nextRun: '2026-11-01', template: { type: 'PB', header: { partyId: 'pv-02', documentDate: '2026-01-01' }, lines: [tl({ itemId: item.id, taxCode: 'EX', expenseCategory: item.expenseCategory })] } }, ME);
    const upd = updateSchedule(st, CO, s.id, { template: { header: { partyId: 'pv-02' }, lines: [tl({ itemId: item.id, taxCode: 'EX' })] } }, ME); // the editor sent no category of its own
    expect(upd.template!.lines[0].expenseCategory).toBe(item.expenseCategory);
  });
  it('an amortisation has no template', () => {
    const a = amort();
    expect(err(() => updateSchedule(st, CO, a.id, body(), ME)).code).toBe('schedule.invalid');
  });
});
