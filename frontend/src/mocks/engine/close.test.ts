import { beforeEach, describe, expect, it } from 'vitest';
import type { Actor, DocLine } from '@/domain/types';
import { buildSeedState, type MockState } from '../store';
import { cancel, createDraft, issue, reissue, revise } from './commands';
import { correctionPlan, executePlan } from './corrections';
import { match, reverseTransfer, transfer, unmatch } from './reconcile';
import { postSettlement, reverseSettlement } from './settlement-records';
import { obProblem } from './opening';
import { disposeAsset, planDepreciation, reverseDisposal, runDepreciation } from './assets';
import { checklistOf, closeInvariants, closePeriod, closeYear, liveYearClose, reopenPeriod, reopenYear } from './close';
import { checkInvariants } from './invariants';
import { generalJournal, reverseJv } from './journal';
import { companyEntries } from './ledger';
import { withFixedClock, type MockError } from './log';
import { runSchedule } from './schedules';
import { toSatang } from './money';
import { isClosed } from './periods';
import { assertBalanced } from './test-helpers';

const ME: Actor = { kind: 'user', id: 'u-1', name: 'สมศรี บัญชีดี' };
const CO = 'co-vat';
let st: MockState, n = 0;
beforeEach(() => { localStorage.clear(); st = buildSeedState(); });

const err = (fn: () => unknown): MockError => { try { fn(); } catch (e) { return e as MockError; } throw new Error('expected a refusal'); };
const period = (month: string, co = CO) => st.periods.find((p) => p.companyId === co && p.month === month)!;
const item = (month: string, code: string, co = CO) => checklistOf(st, co, month).find((i) => i.code === code)!;
const L = (code: string, debit: string, credit: string): DocLine =>
  ({ id: `cl-${++n}`, description: `รายการ ${code}`, qty: '1', unit: '', unitPrice: '0.00', taxCode: 'EX', accountCode: code, debit, credit });
const jv = (date: string, lines: DocLine[]) => { const d = createDraft(st, CO, 'JV', { header: { documentDate: date }, lines }, ME, `c${++n}`); return issue(st, d.id, d.version, ME); };
/** Seed history is replayed under a pinned clock; do the same so a 2025 entry is posted "as of" 2025 (before the month closed). */
const in2025 = <T,>(fn: () => T): T => withFixedClock('2025-07-01T09:00:00+07:00', fn);
/** The seed's assets, runs and disposal invoices removed (the AC5 test helper): a month with no asset has nothing to depreciate. */
const noAssets = () => {
  const gone = new Set(st.docs.filter((d) => d.type === 'FA' || d.type === 'DP' || d.header.disposal).map((d) => d.id));
  for (const d of st.docs) if (gone.has(d.id) && d.header.disposal) st.series[`${d.companyId}|${d.type}|${d.header.documentDate.slice(0, 7)}`] -= 1;
  st.docs = st.docs.filter((d) => !gone.has(d.id)); st.journals = st.journals.filter((j) => !gone.has(j.docId));
  st.series = Object.fromEntries(Object.entries(st.series).filter(([k]) => !/\|(FA|DP)\|/.test(k)));
};
/** September's depreciation (the seed leaves it due), then 2026-07..2026-09 closed in order. */
/** What the closer saw and accepted: the month's warnings as {code, count}. */
const ack = (month: string) => checklistOf(st, CO, month).filter((i) => i.count > 0 && i.severity === 'warning').map(({ code, count }) => ({ code, count }));
const closeThroughSep = () => { if (st.docs.some((d) => d.type === 'FA')) runDepreciation(st, CO, '2026-09', ME); for (const m of ['2026-07', '2026-08', '2026-09']) closePeriod(st, CO, m, ME, { acknowledge: ack(m) }); };
/** Σ debit - Σ credit (satang) per P&L account (4xxx / 5xxx) of the entries dated in `year`; `close` false = without the closing entries. */
const plBalances = (year: number, close = true): Record<string, number> => {
  const m: Record<string, number> = {};
  for (const e of companyEntries(st, CO, close)) if (e.date.startsWith(`${year}-`)) for (const l of e.lines) if (/^[45]/.test(l.accountCode)) m[l.accountCode] = (m[l.accountCode] ?? 0) + toSatang(l.debit) - toSatang(l.credit);
  return Object.fromEntries(Object.entries(m).filter(([, v]) => v !== 0));
};
const bal = (code: string, year: number, close = true) => { let s = 0; for (const e of companyEntries(st, CO, close)) if (e.date.startsWith(`${year}-`)) for (const l of e.lines) if (l.accountCode === code) s += toSatang(l.debit) - toSatang(l.credit); return s; };

describe('checklist (ruling 2)', () => {
  it('states the six codes; filings_not_finalized waits for TX1 and is 0', () => {
    expect(checklistOf(st, CO, '2026-07').map((i) => i.code)).toEqual(['drafts_in_month', 'unreconciled_bank_lines', 'depreciation_not_run', 'schedules_not_run', 'filings_not_finalized', 'ob_difference_open']);
    expect(item('2026-07', 'filings_not_finalized')).toMatchObject({ count: 0, severity: 'warning' });
    expect(checklistOf(st, CO, '2026-07').find((i) => i.severity === 'blocking')?.code).toBe('depreciation_not_run');
  });
  it('drafts_in_month counts every unissued document dated in the month (warning, list link)', () => {
    expect(item('2026-07', 'drafts_in_month').count).toBe(0);
    createDraft(st, CO, 'JV', { header: { documentDate: '2026-07-10' }, lines: [L('5110', '10.00', '0.00'), L('2120', '0.00', '10.00')] }, ME, 'dm1');
    expect(item('2026-07', 'drafts_in_month')).toMatchObject({ count: 1, severity: 'warning' });
    expect(item('2026-10', 'drafts_in_month').count).toBe(st.docs.filter((d) => d.companyId === CO && ['draft', 'pending', 'approved'].includes(d.status) && d.header.documentDate.startsWith('2026-10')).length);
  });
  it('unreconciled_bank_lines counts the statement lines of the month nobody matched, posted or ignored', () => {
    expect(item('2026-09', 'unreconciled_bank_lines').count).toBe(st.bankLines.filter((l) => l.companyId === CO && l.date.startsWith('2026-09') && l.status === 'unmatched').length);
    expect(item('2026-09', 'unreconciled_bank_lines').count).toBeGreaterThan(0);
    expect(item('2026-07', 'unreconciled_bank_lines').count).toBe(0);
    const l = st.bankLines.find((x) => x.companyId === CO && x.date.startsWith('2026-09'))!;
    l.status = 'ignored';
    expect(item('2026-09', 'unreconciled_bank_lines').count).toBe(st.bankLines.filter((x) => x.companyId === CO && x.date.startsWith('2026-09') && x.status === 'unmatched').length);
  });
  it('depreciation_not_run is blocking while an asset has no live run for the month, and clears when the run exists', () => {
    expect(item('2026-07', 'depreciation_not_run').count).toBe(0); // the seed ran July and August
    expect(item('2026-08', 'depreciation_not_run').count).toBe(0);
    expect(item('2026-09', 'depreciation_not_run')).toMatchObject({ count: 1, severity: 'blocking', href: '/accounting/depreciation-runs/new' }); // fa-scan; fa-sold was sold in September, fa-nb starts in October
    runDepreciation(st, CO, '2026-09', ME);
    expect(item('2026-09', 'depreciation_not_run').count).toBe(0);
    expect(item('2026-06', 'depreciation_not_run').count).toBe(0); // no asset yet
  });
  it('a company without assets in the month is never blocked', () => {
    expect(item('2025-03', 'depreciation_not_run').count).toBe(0);
    expect(item('2026-09', 'depreciation_not_run', 'co-nonvat')).toMatchObject({ count: 2, severity: 'blocking' }); // nfa-1 ran through August; nfa-car (AC7a, depFrom September: its catch-up) is due too
  });
  it('schedules_not_run counts plan months up to the month with no live run (warning)', () => {
    expect(item('2026-09', 'schedules_not_run').count).toBe(0); // July, August, September ran
    expect(item('2026-10', 'schedules_not_run')).toMatchObject({ count: 1, severity: 'warning' });
    expect(item('2026-11', 'schedules_not_run').count).toBe(2);
  });
  it('ob_difference_open is a warning while a live opening balance carries a 3900 plug', () => {
    const ob = st.docs.find((d) => d.companyId === 'co-nonvat' && d.type === 'OB' && !d.header.obBatchId && d.status === 'issued')!;
    const plug = st.journals.find((j) => j.docId === ob.id)!.preview.entries[0].lines.find((l) => l.accountCode === '3900');
    expect(item('2026-07', 'ob_difference_open', 'co-nonvat')).toMatchObject({ severity: 'warning', count: plug && toSatang(plug.debit) + toSatang(plug.credit) !== 0 ? 1 : 0 });
    expect(item('2026-07', 'ob_difference_open').count).toBe(0); // co-vat has no live batch
  });
});

describe('close a month (ruling 1, 2)', () => {
  it('closes with closedAt, closedBy and an audit row; invariants hold; the month now refuses documents', () => {
    const p = closePeriod(st, CO, '2026-07', ME);
    expect(p).toMatchObject({ status: 'closed', closedBy: ME });
    expect(Date.parse(p.closedAt!)).toBeLessThanOrEqual(Date.now());
    expect(isClosed(st, CO, '2026-07-31')).toBe(true);
    expect(st.audit.at(-1)).toMatchObject({ command: 'period.close', target: '2026-07', companyId: CO });
    assertBalanced(st);
  });
  it('months close in order: an earlier open month must close first (period.order)', () => {
    const e = err(() => closePeriod(st, CO, '2026-08', ME));
    expect(e.code).toBe('period.order');
    expect(e.title).toContain('ก.ค. 2569');
    expect(period('2026-08').status).toBe('open');
  });
  it('a blocking item refuses the close and names its exit', () => {
    closePeriod(st, CO, '2026-07', ME); closePeriod(st, CO, '2026-08', ME);
    const e = err(() => closePeriod(st, CO, '2026-09', ME, { acknowledge: ack('2026-09') }));
    expect(e.code).toBe('period.blocked');
    expect(e.title).toContain('/accounting/depreciation-runs/new'); // exits = the items' links
    expect(period('2026-09').status).toBe('open');
    runDepreciation(st, CO, '2026-09', ME);
    expect(closePeriod(st, CO, '2026-09', ME, { acknowledge: ack('2026-09') }).status).toBe('closed');
  });
  it('a warning needs the explicit acknowledge flag; the acknowledged list is frozen on the close record', () => {
    const d = createDraft(st, CO, 'JV', { header: { documentDate: '2026-07-10' }, lines: [L('5110', '10.00', '0.00'), L('2120', '0.00', '10.00')] }, ME, 'ack1');
    const e = err(() => closePeriod(st, CO, '2026-07', ME));
    expect(e.code).toBe('period.warnings');
    expect(e.title).toContain('ฉบับร่าง');
    expect(period('2026-07').status).toBe('open');
    closePeriod(st, CO, '2026-07', ME, { acknowledge: ack('2026-07') });
    expect(period('2026-07').acknowledged).toEqual([expect.objectContaining({ code: 'drafts_in_month', count: 1, severity: 'warning' })]);
    st.docs = st.docs.filter((x) => x.id !== d.id); // the draft goes away; what was acknowledged does not change
    expect(period('2026-07').acknowledged).toEqual([expect.objectContaining({ code: 'drafts_in_month', count: 1 })]);
  });
  it('closing again is refused; an unknown month is 404', () => {
    closePeriod(st, CO, '2026-07', ME);
    expect(err(() => closePeriod(st, CO, '2026-07', ME)).code).toBe('period.already_closed');
    expect(err(() => closePeriod(st, CO, '2031-07', ME)).code).toBe('period.not_found');
  });
});

describe('reopen a month (ruling 1)', () => {
  it('needs a reason; only the latest closed month reopens (period.reopen_order); history and audit record it', () => {
    closePeriod(st, CO, '2026-07', ME);
    expect(err(() => reopenPeriod(st, CO, '2026-07', ME, '  ')).code).toBe('period.reason_required');
    const e = err(() => reopenPeriod(st, CO, '2026-06', ME, 'แก้ไขยอด'));
    expect(e.code).toBe('period.reopen_order');
    expect(e.title).toContain('ก.ค. 2569'); // exit: reopen the later month first
    const p = reopenPeriod(st, CO, '2026-07', ME, 'พบรายการตกหล่น');
    expect(p.status).toBe('open');
    expect(p.closedAt).toBeUndefined();
    expect(p.reopened).toEqual([{ at: expect.any(String), reason: 'พบรายการตกหล่น', by: ME }]);
    expect(st.audit.at(-1)).toMatchObject({ command: 'period.reopen', target: '2026-07', after: expect.objectContaining({ reason: 'พบรายการตกหล่น' }) });
    closePeriod(st, CO, '2026-07', ME);
    reopenPeriod(st, CO, '2026-07', ME, 'อีกครั้ง');
    expect(period('2026-07').reopened).toHaveLength(2); // appended, never replaced
    assertBalanced(st);
  });
  it('an open month cannot be reopened', () => {
    expect(err(() => reopenPeriod(st, CO, '2026-08', ME, 'x')).code).toBe('period.not_closed');
  });
});

describe('late entries (ruling 6)', () => {
  it('closing a month that holds late entries keeps every journal balanced and invariant 7 green', () => {
    noAssets(); // October still has assets to depreciate, and the run cannot be made before the month ends; this test is about the late entry
    closeThroughSep();
    const ti = st.docs.find((d) => d.companyId === CO && d.type === 'TI' && d.status === 'issued' && d.header.documentDate.startsWith('2026-05') && !st.links.some((l) => l.active && l.to === d.id))!;
    cancel(st, ti.id, ti.version, 'OTHER', 'แก้ไขย้อนหลัง', ME, { correction: true }); // the reversal posts late, in the first open month
    const late = st.journals.find((j) => j.docId === ti.id)!.preview.entries.at(-1)!;
    expect(late).toMatchObject({ kind: 'reversal', late: true });
    expect(late.date.startsWith('2026-10')).toBe(true);
    closePeriod(st, CO, '2026-10', ME, { acknowledge: ack('2026-10') });
    assertBalanced(st);
    expect(Date.parse(late.postedAt!)).toBeLessThanOrEqual(Date.parse(period('2026-10').closedAt!));
    expect(checkInvariants(st)).toEqual([]);
  });
});

describe('year-end close (ruling 3)', () => {
  /** 2025 holds revenue only in the seed; give it expenses and a contra so the sweep has both sides. */
  const give2025 = () => in2025(() => { jv('2025-06-15', [L('5110', '30000.00', '0.00'), L('2120', '0.00', '30000.00')]); jv('2025-07-20', [L('4110', '2000.00', '0.00'), L('2120', '0.00', '2000.00')]); jv('2025-08-20', [L('2120', '500.00', '0.00'), L('5170', '0.00', '500.00')]); });

  it('needs all twelve months closed', () => {
    const e = err(() => closeYear(st, CO, 2026, ME));
    expect(e.code).toBe('period.year_months_open');
    expect(e.title).toContain('ก.ค. 2569');
    expect(liveYearClose(st, CO, 2026)).toBeUndefined();
    expect(err(() => closeYear(st, CO, 2031, ME)).code).toBe('period.not_found');
  });
  it('a year not over cannot close', () => {
    for (const p of st.periods.filter((x) => x.companyId === CO && x.month.startsWith('2026-'))) { p.status = 'closed'; p.closedAt = '2099-01-01T00:00:00Z'; }
    expect(err(() => closeYear(st, CO, 2026, ME)).code).toBe('period.year_not_ended');
  });
  it('posts the closing entry on the last day: P&L accounts to 0 against 3300, then 3300 into 3200 for the net', () => {
    give2025();
    const before = plBalances(2025), r3200 = bal('3200', 2025), r3300 = bal('3300', 2025);
    const yc = closeYear(st, CO, 2025, ME);
    expect(yc).toMatchObject({ year: 2025, date: '2025-12-31', closedBy: ME });
    const e = yc.journal[0];
    expect(e).toMatchObject({ date: '2025-12-31', kind: 'original' });
    expect(Date.parse(e.postedAt!)).toBeGreaterThan(Date.parse('2026-01-01')); // own postedAt, after the December close
    // every P&L account's closing line is the opposite of its balance from the other entries
    for (const [code, v] of Object.entries(before)) {
      const line = e.lines.filter((l) => l.accountCode === code);
      expect(line).toHaveLength(1);
      expect(toSatang(line[0].debit) - toSatang(line[0].credit)).toBe(-v);
    }
    expect(plBalances(2025)).toEqual({}); // every revenue / expense account is 0 for the year
    expect(bal('3300', 2025)).toBe(r3300); // the income summary nets to nothing
    const net = -Object.values(before).reduce((a, b) => a + b, 0); // Σ revenue - Σ expense
    expect(net).toBe(toSatang('1247575.00') - toSatang('30000.00') - toSatang('2000.00') + toSatang('500.00'));
    expect(bal('3200', 2025) - r3200).toBe(-net); // Δ GL(3200) = net profit (debit - credit sign)
    expect(e.lines.find((l) => l.accountCode === '3200')).toMatchObject({ credit: '1216075.00', debit: '0.00' });
    const dr = e.lines.reduce((a, l) => a + toSatang(l.debit), 0), cr = e.lines.reduce((a, l) => a + toSatang(l.credit), 0);
    expect(dr).toBe(cr);
    expect(closeInvariants(st)).toEqual([]);
    assertBalanced(st);
    expect(generalJournal(st, CO, { from: '2025-12-31', to: '2025-12-31' }).rows.some((r) => String(r.cells.entry).includes('ปิดบัญชีสิ้นปี'))).toBe(true);
  });
  it('a loss year posts the other way round', () => {
    in2025(() => jv('2025-06-15', [L('5110', '2000000.00', '0.00'), L('2120', '0.00', '2000000.00')]));
    closeYear(st, CO, 2025, ME);
    const e = liveYearClose(st, CO, 2025)!.journal[0];
    expect(e.lines.find((l) => l.accountCode === '3200')).toMatchObject({ debit: '752425.00', credit: '0.00' }); // 1,247,575.00 - 2,000,000.00
    expect(closeInvariants(st)).toEqual([]);
  });
  it('one live closing entry per company-year; closing twice is refused', () => {
    closeYear(st, CO, 2025, ME);
    expect(err(() => closeYear(st, CO, 2025, ME)).code).toBe('period.year_closed');
  });
  it('3300 is a controlled account: a JV on it is refused with the year-end exit', () => {
    const e = err(() => createDraft(st, CO, 'JV', { header: { documentDate: '2026-10-10' }, lines: [L('3300', '10.00', '0.00'), L('2120', '0.00', '10.00')] }, ME, 'ctl') && issue(st, st.docs.at(-1)!.id, 1, ME));
    expect(e.code).toBe('ledger.control_account');
    expect(e.title).toContain('ปิดบัญชีสิ้นปี');
  });
  it('a company without P&L in the year closes with no lines but still balances', () => {
    const yc = closeYear(st, 'co-nonvat', 2025, ME);
    expect(yc.journal[0].lines).toEqual([]);
    expect(closeInvariants(st)).toEqual([]);
  });
});

describe('a closed year is final (ruling 5)', () => {
  it('refuses a new posting dated in the year (period.year_closed with the reopen-the-year exit)', () => {
    closeYear(st, CO, 2025, ME);
    const d = createDraft(st, CO, 'JV', { header: { documentDate: '2025-05-10' }, lines: [L('5110', '10.00', '0.00'), L('2120', '0.00', '10.00')] }, ME, 'y1');
    const e = err(() => issue(st, d.id, d.version, ME));
    expect(e.code).toBe('period.year_closed');
    expect(e.title).toContain('เปิดปีบัญชี');
  });
  it('refuses the late correction of a document of the year, but not of a closed month of an open year', () => {
    const ti = st.docs.find((d) => d.id === 'spike-1')!; // a 2025 tax invoice nothing is linked to
    closeYear(st, CO, 2025, ME);
    expect(err(() => cancel(st, ti.id, ti.version, 'OTHER', 'x', ME, { correction: true })).code).toBe('period.year_closed');
    expect(st.journals.find((j) => j.docId === ti.id)!.preview.entries.at(-1)!.kind).not.toBe('reversal');
    expect(st.docs.find((d) => d.id === ti.id)!.status).toBe('issued');
    const may = st.docs.find((x) => x.companyId === CO && x.type === 'TI' && x.status === 'issued' && x.header.documentDate.startsWith('2026-05') && !st.links.some((l) => l.active && l.to === x.id))!;
    expect(() => cancel(st, may.id, may.version, 'OTHER', 'x', ME, { correction: true })).not.toThrow(); // 2026 is an open year: "แก้ไขย้อนหลัง" stays
  });
  it('refuses revise of a document of the year', () => {
    const j = in2025(() => jv('2025-06-15', [L('5110', '100.00', '0.00'), L('2120', '0.00', '100.00')]));
    closeYear(st, CO, 2025, ME);
    expect(err(() => revise(st, j.id, { header: { ...j.header, notes: 'x' }, lines: j.lines }, j.version, 'x', ME)).code).toBe('period.year_closed');
  });
  it('refuses the reversal of a JV of the year', () => {
    const j = in2025(() => jv('2025-06-15', [L('5110', '100.00', '0.00'), L('2120', '0.00', '100.00')]));
    closeYear(st, CO, 2025, ME);
    expect(err(() => reverseJv(st, j.id, ME)).code).toBe('period.year_closed');
  });
  it('refuses to issue, revise or cancel an opening balance dated in the year (the D-10 exemption ends at a closed year)', () => {
    const ob = st.docs.find((d) => d.companyId === 'co-nonvat' && d.type === 'OB' && !d.header.obBatchId && d.status === 'issued')!;
    expect(ob.header.documentDate).toBe('2025-12-31');
    closeYear(st, 'co-nonvat', 2025, ME);
    expect(err(() => cancel(st, ob.id, ob.version, 'OTHER', 'x', ME)).code).toBe('period.year_closed');
    expect(err(() => revise(st, ob.id, { header: ob.header, lines: ob.lines, opening: ob.opening }, ob.version, 'x', ME)).code).toBe('period.year_closed');
    const d = createDraft(st, 'co-nonvat', 'OB', { header: { documentDate: '2025-11-30' }, lines: [L('2120', '0.00', '100.00')], opening: { openItems: [], assets: [], payrollYtd: [], bank: [] } }, ME, 'ob2');
    expect(err(() => issue(st, d.id, d.version, ME)).code).toBe('period.year_closed');
  });
  it('refuses a depreciation run and a schedule run dated in the year, whatever else they would be refused for', () => {
    closeYear(st, CO, 2025, ME);
    expect(planDepreciation(st, CO, '2025-12').problem?.code).toBe('period.year_closed'); // not 'dp.out_of_order'
    expect(err(() => runDepreciation(st, CO, '2025-12', ME)).code).toBe('period.year_closed');
    const rec = st.schedules.find((x) => x.companyId === CO && x.kind === 'recurring' && !x.stopped)!;
    rec.nextRun = '2025-05-10';
    expect(err(() => runSchedule(st, CO, rec.id, ME)).code).toBe('period.year_closed');
    const am = st.schedules.find((x) => x.companyId === CO && x.kind === 'amortisation')!;
    am.runs = []; am.plan = am.plan!.map((r, i) => ({ ...r, month: `2025-${String(i + 1).padStart(2, '0')}` })); // a plan that lives in the closed year
    expect(err(() => runSchedule(st, CO, am.id, ME)).code).toBe('period.year_closed');
  });
  it('months of a closed year cannot be reopened (exit: reopen the year)', () => {
    closeYear(st, CO, 2025, ME);
    const e = err(() => reopenPeriod(st, CO, '2025-12', ME, 'x'));
    expect(e.code).toMatch(/period\.(year_closed|reopen_order)/);
    expect(e.title).toContain('เปิดปีบัญชี');
  });
});

describe('reopen the year (ruling 5)', () => {
  it('needs a reason; reverses the closing entry on the last day with its own postedAt and restores the balances exactly', () => {
    in2025(() => jv('2025-06-15', [L('5110', '30000.00', '0.00'), L('2120', '0.00', '30000.00')]));
    const before = plBalances(2025, false), b3200 = bal('3200', 2025), b3300 = bal('3300', 2025);
    const yc = closeYear(st, CO, 2025, ME);
    expect(err(() => reopenYear(st, CO, 2025, ME, '')).code).toBe('period.reason_required');
    const re = reopenYear(st, CO, 2025, ME, 'ปรับปรุงรายการผู้สอบบัญชี');
    expect(re.journal.map((e) => e.kind)).toEqual(['original', 'reversal']);
    const rev = re.journal[1];
    expect(rev).toMatchObject({ date: '2025-12-31' });
    expect(Date.parse(rev.postedAt!)).toBeGreaterThanOrEqual(Date.parse(yc.journal[0].postedAt!));
    expect(re.reopened).toMatchObject({ reason: 'ปรับปรุงรายการผู้สอบบัญชี', by: ME });
    expect(liveYearClose(st, CO, 2025)).toBeUndefined();
    expect(plBalances(2025)).toEqual(before); // exactly the pre-close figures
    expect(bal('3200', 2025)).toBe(b3200);
    expect(bal('3300', 2025)).toBe(b3300);
    expect(st.audit.at(-1)).toMatchObject({ command: 'period.year_reopen', target: '2025' });
    expect(closeInvariants(st)).toEqual([]);
    assertBalanced(st);
    // months are reopenable latest-first once the later year's months are open: 2026 months 01..06 are closed, so 2026-06 comes first
    expect(err(() => reopenPeriod(st, CO, '2025-12', ME, 'x')).code).toBe('period.reopen_order');
    // and a fresh close works again, with one live entry
    const again = closeYear(st, CO, 2025, ME);
    expect(again.id).not.toBe(yc.id);
    expect(st.yearCloses.filter((y) => y.companyId === CO && y.year === 2025 && !y.reopened)).toHaveLength(1);
  });
  it('an open year cannot be reopened', () => {
    expect(err(() => reopenYear(st, CO, 2025, ME, 'x')).code).toBe('period.year_not_closed');
  });
  it('after the reopen the postings of the year work again', () => {
    closeYear(st, CO, 2025, ME);
    reopenYear(st, CO, 2025, ME, 'x');
    expect(() => in2025(() => jv('2025-09-10', [L('5110', '1.00', '0.00'), L('2120', '0.00', '1.00')]))).not.toThrow();
  });
});

describe('closing-entry invariants fail on a single fault (ruling 3)', () => {
  beforeEach(() => {
    in2025(() => { jv('2025-06-15', [L('5110', '30000.00', '0.00'), L('2120', '0.00', '30000.00')]); jv('2025-07-20', [L('4110', '2000.00', '0.00'), L('2120', '0.00', '2000.00')]); });
    closeYear(st, CO, 2025, ME);
    expect(closeInvariants(st)).toEqual([]);
  });
  const entry = () => st.yearCloses.find((y) => y.companyId === CO && y.year === 2025)!.journal[0];
  /** One fault, then the message of THE check that owns it (every tamper is also seen by the generic checkInvariants). */
  const tamper = (fn: () => void, match: RegExp, generic = false) => { fn(); if (!generic) expect(closeInvariants(st).join(' | ')).toMatch(match); expect(checkInvariants(st).join(' | ')).toMatch(match); };
  const jvJournal = () => st.journals.find((x) => st.docs.find((d) => d.id === x.docId)!.type === 'JV' && x.preview.entries[0].date.startsWith('2025-'))!; // the 5110 journal of the setup
  const late = (code: string) => jvJournal().preview.entries.push({ date: '2025-11-01', kind: 'original', postedAt: '2026-02-01T00:00:00Z', lines: [{ accountCode: code, accountName: 'x', debit: '1.00', credit: '0.00', rule: 'x' }, { accountCode: '2120', accountName: 'x', debit: '0.00', credit: '1.00', rule: 'x' }] });
  it('a P&L closing line off by a satang', () => tamper(() => { const l = entry().lines.find((x) => x.accountCode === '5110')!; l.credit = '29999.99'; }, /closing line of 5110/));
  it('a P&L account dropped from the sweep', () => tamper(() => { entry().lines = entry().lines.filter((x) => x.accountCode !== '4110'); }, /closing line of 4110/));
  it('a P&L line on the wrong side', () => tamper(() => { const l = entry().lines.find((x) => x.accountCode === '5110')!; [l.debit, l.credit] = [l.credit, l.debit]; }, /closing line of 5110/));
  it('a line on an account that has nothing to sweep', () => tamper(() => { entry().lines.push({ accountCode: '2120', accountName: 'x', debit: '5.00', credit: '0.00', rule: 'x' }, { accountCode: '2120', accountName: 'x', debit: '0.00', credit: '5.00', rule: 'x' }); }, /touches 2120/));
  it('the 3200 line is not the net', () => tamper(() => { const l = entry().lines.find((x) => x.accountCode === '3200')!; l.credit = fromS(toSatang(l.credit) + 1); }, /3200 .3200. line is/));
  it('the recorded net is not the net', () => tamper(() => { st.yearCloses[0].net = '1.00'; }, /recorded net/));
  it('the entry does not balance', () => tamper(() => { entry().lines.find((x) => x.accountCode === '3200')!.credit = '1.00'; }, /unbalanced/, true));
  it('an entry dated in the year after the close leaves a P&L balance', () => tamper(() => late('5110'), /5110 still has a balance/));
  it('an entry dated in the year after the close leaves 3300 with a balance', () => tamper(() => late('3300'), /3300 .3300. has a balance/));
  it('a month of the closed year reopened by hand', () => tamper(() => { period('2025-12').status = 'open'; }, /month 2025-12 is not closed/));
  it('two live closing entries for one company-year', () => tamper(() => { const y = st.yearCloses[0]; st.yearCloses.push({ ...y, id: `${y.id}-dup` }); }, /more than one/));
  it('a live closing entry not dated the last day of its year', () => tamper(() => { entry().date = '2025-12-30'; }, /not the last day/));
  it('a closed-year entry whose reversal is not the exact mirror', () => {
    reopenYear(st, CO, 2025, ME, 'x');
    tamper(() => { st.yearCloses.find((y) => y.reopened)!.journal[1].lines[0].debit = '1.00'; }, /exact mirror/);
  });
});

const fromS = (s: number) => (s / 100).toFixed(2);

// ---------------------------------------------------------------- AC6 fix round 1 (Opus Tier-2 REJECT): the probes P1 / P2 / P3 / P7 / P9 as tests
describe('fix1', () => {
  const cust = () => st.parties.find((p) => p.companyId === CO && p.kind === 'customer' && p.vatRegistered && p.taxId)!.id;
  const tiLine = (): DocLine => ({ id: 'l1', description: 'x', qty: '1', unit: 'u', unitPrice: '1000.00', taxCode: 'S7' });
  const ti2025 = (date: string, key: string) => in2025(() => { const d = createDraft(st, CO, 'TI', { header: { partyId: cust(), documentDate: date }, lines: [tiLine()] }, ME, key); return issue(st, d.id, d.version, ME); });
  const other = (partyId?: string) => st.parties.find((p) => p.companyId === CO && p.kind === 'customer' && p.id !== partyId && p.vatRegistered && p.taxId)!;
  const entriesOf = (id: string) => st.journals.find((j) => j.docId === id)!.preview.entries;

  describe('F1: a correction plan never reaches a closed-year document', () => {
    it('buildPlan refuses before any plan is shown, and nothing is written (P7)', () => {
      const ti = ti2025('2025-11-12', 'f1a');
      closeYear(st, CO, 2025, ME);
      const e = err(() => correctionPlan(st, ti.id, { header: { ...ti.header, partyId: other(ti.header.partyId).id }, lines: ti.lines }, 'accountant'));
      expect(e.code).toBe('period.year_closed');
      expect(st.docs.find((d) => d.id === ti.id)!.status).toBe('issued');
    });
    it('reissue() is the backstop: it refuses and leaves the old document untouched', () => {
      const ti = ti2025('2025-11-12', 'f1b');
      closeYear(st, CO, 2025, ME);
      const docs = st.docs.length;
      expect(err(() => reissue(st, ti.id, { header: { ...ti.header, partyId: other(ti.header.partyId).id }, lines: ti.lines }, ME, 'x')).code).toBe('period.year_closed');
      expect(st.docs).toHaveLength(docs);
      expect(entriesOf(ti.id)).toHaveLength(1);
    });
    it('a plan on an open-year document still works', () => {
      const ti = ti2025('2025-11-12', 'f1c');
      const plan = correctionPlan(st, ti.id, { header: { ...ti.header, partyId: other(ti.header.partyId).id }, lines: ti.lines }, 'accountant');
      expect(() => executePlan(st, plan.planId, plan.planHash, ME)).not.toThrow();
    });
  });

  describe('F2: 3300 is never an opening-balance line', () => {
    const NCO = 'co-nonvat';
    const nonvatCode = (sub: string) => st.accounts.find((a) => a.companyId === NCO && a.subClass === sub)!.code;
    it('obProblem refuses an OB line on the current-year account with the Thai exit (P3)', () => {
      const ob = st.docs.find((d) => d.id === 'nob-1')!;
      const lines = [...ob.lines, L(nonvatCode('current-year'), '5000.00', '0.00'), L(nonvatCode('retained'), '0.00', '5000.00')];
      const e = obProblem(st, NCO, { header: ob.header, lines, opening: ob.opening } as never, ob.id)!;
      expect(e.code).toBe('ledger.control_account');
      expect(e.title).toContain('3200');
      expect(err(() => revise(st, ob.id, { header: ob.header, lines, opening: ob.opening } as never, ob.version, 'x', ME)).code).toBe('ledger.control_account');
    });
    it('the seed OB batches do not use it', () => {
      const cy = new Set(st.accounts.filter((a) => a.subClass === 'current-year').map((a) => `${a.companyId}|${a.code}`));
      expect(st.docs.filter((d) => d.type === 'OB').flatMap((d) => d.lines.map((l) => `${d.companyId}|${l.accountCode}`)).filter((k) => cy.has(k))).toEqual([]);
    });
  });

  describe('F3: "in a closed year" is the strictest of the document date and its non-reversal entries', () => {
    it('a 2025 document reissued late BEFORE the close cannot be cancelled after it (P9)', () => {
      const ti = ti2025('2025-11-13', 'f3a');
      const plan = correctionPlan(st, ti.id, { header: { ...ti.header, partyId: other(ti.header.partyId).id }, lines: ti.lines }, 'accountant');
      executePlan(st, plan.planId, plan.planHash, ME);
      const nu = st.docs.find((d) => d.id === st.docs.find((x) => x.id === ti.id)!.replacedById)!;
      expect(nu.header.documentDate).toBe('2025-11-13');
      expect(entriesOf(nu.id).at(-1)!.date.startsWith('2026')).toBe(true);
      closeYear(st, CO, 2025, ME);
      expect(err(() => cancel(st, nu.id, nu.version, 'OTHER', 'x', ME)).code).toBe('period.year_closed');
      expect(err(() => revise(st, nu.id, { header: { ...nu.header, notes: 'x' }, lines: nu.lines }, nu.version, 'x', ME)).code).toBe('period.year_closed');
    });
    it('a document of an open year whose entry sits in a closed year is refused too', () => {
      const may = st.docs.find((x) => x.companyId === CO && x.type === 'TI' && x.status === 'issued' && x.header.documentDate.startsWith('2026-05') && !st.links.some((l) => l.active && l.to === x.id))!;
      closeYear(st, CO, 2025, ME);
      entriesOf(may.id)[0].date = '2025-12-20';
      expect(err(() => cancel(st, may.id, may.version, 'OTHER', 'x', ME)).code).toBe('period.year_closed');
    });
  });

  describe('F4: no path reverses an entry dated in a closed year', () => {
    it('a settlement (P1)', () => {
      const ti = ti2025('2025-11-10', 'f4a');
      const s = in2025(() => postSettlement(st, CO, { kind: 'write_off', date: '2025-11-20', partyId: cust(), targets: [{ docId: ti.id, amount: '0.50' }], difference: { role: 'RoundingDifference', amount: '0.50' } }, ME));
      closeYear(st, CO, 2025, ME);
      expect(err(() => reverseSettlement(st, CO, s.id, ME, 'x')).code).toBe('period.year_closed');
      expect(st.settlements.find((x) => x.id === s.id)!.status).not.toBe('reversed');
    });
    it('a bank transfer (P2)', () => {
      const src = st.bankLines.find((l) => l.id === 'bi-001-001')!;
      const copy = { ...structuredClone(src), id: 'bl-f4', date: '2025-11-15', status: 'unmatched' } as Record<string, unknown>;
      delete copy.matches; delete copy.matchedDocIds; delete copy.diff; delete copy.transfer;
      st.bankLines.push(copy as never);
      in2025(() => transfer(st, CO, 'bl-f4', 'ba-scb', ME));
      const j = st.bankJournals.find((x) => x.lineId === 'bl-f4')!;
      closeYear(st, CO, 2025, ME);
      unmatch(st, CO, 'bl-f4', ME, 'x');
      expect(err(() => reverseTransfer(st, CO, j.id, ME, 'x')).code).toBe('period.year_closed');
      expect(j.entries).toHaveLength(1);
    });
    it('a bank fee / rounding journal on unmatch', () => {
      const id = 'bl-fee';
      st.bankLines.push({ companyId: CO, id, accountId: st.bankLines.find((x) => x.id === 'bi-001-003')!.accountId, importId: 'bi-001', date: '2026-09-05', description: 'ทดสอบ', amount: '6930.00', balance: '0.00', status: 'unmatched' });
      const l = match(st, CO, id, { docIds: ['rc-013'], diff: { role: 'BankFee', amount: '-25.00' } }, ME);
      const j = st.bankJournals.find((x) => x.id === l.diff!.journalId)!;
      j.entries[0].date = '2025-11-20'; // a fee posted in the year that is about to close
      closeYear(st, CO, 2025, ME);
      expect(err(() => unmatch(st, CO, id, ME, 'x')).code).toBe('period.year_closed');
      expect(j.entries).toHaveLength(1);
    });
    it('a write-off undispose', () => {
      closeThroughSep();
      const fa = st.docs.find((d) => d.type === 'FA' && d.companyId === CO && !d.asset?.disposed && d.status === 'issued');
      if (!fa) throw new Error('the seed has no live asset');
      disposeAsset(st, CO, fa.id, { date: '2026-10-10', kind: 'write_off' }, ME);
      entriesOf(fa.id).at(-1)!.date = '2025-12-20';
      closeYear(st, CO, 2025, ME);
      expect(err(() => reverseDisposal(st, CO, fa.id, ME)).code).toBe('period.year_closed');
      expect(st.docs.find((d) => d.id === fa.id)!.asset!.disposed).toBeDefined();
    });
    it('reopenYear still works (its own reversal)', () => {
      closeYear(st, CO, 2025, ME);
      expect(() => reopenYear(st, CO, 2025, ME, 'r')).not.toThrow();
    });
  });

  describe('stale acknowledgement', () => {
    it('refuses a close whose acknowledged warnings differ from the current ones', () => {
      const seen = ack('2026-07');
      expect(seen).toEqual([]);
      createDraft(st, CO, 'JV', { header: { documentDate: '2026-07-10' }, lines: [] }, ME, 'sa1'); // a warning appears between the preview and the close
      expect(err(() => closePeriod(st, CO, '2026-07', ME, { acknowledge: seen })).code).toBe('period.warnings');
      expect(period('2026-07').status).toBe('open');
      expect(err(() => closePeriod(st, CO, '2026-07', ME, { acknowledge: [{ code: 'drafts_in_month', count: 2 }] })).code).toBe('period.warnings');
      expect(err(() => closePeriod(st, CO, '2026-07', ME)).code).toBe('period.warnings');
      closePeriod(st, CO, '2026-07', ME, { acknowledge: ack('2026-07') });
      expect(period('2026-07').acknowledged).toEqual([expect.objectContaining({ code: 'drafts_in_month', count: 1 })]);
    });
    it('a list for warnings that are gone is stale too', () => {
      expect(err(() => closePeriod(st, CO, '2026-07', ME, { acknowledge: [{ code: 'drafts_in_month', count: 1 }] })).code).toBe('period.warnings');
    });
  });

  describe('year order', () => {
    /** The seed's calendar starts in 2025, so a 2024 of closed months is added to have an earlier year (today is 2026-10-01: 2026 itself cannot close here). */
    const with2024 = () => { for (let m = 1; m <= 12; m++) st.periods.unshift({ companyId: CO, month: `2024-${String(m).padStart(2, '0')}`, status: 'closed', closedAt: '2025-01-02T00:00:00Z' }); };
    it('closeYear refuses while an earlier year has no live closing entry', () => {
      with2024();
      const e = err(() => closeYear(st, CO, 2025, ME));
      expect(e.code).toBe('period.year_order');
      expect(e.title).toContain('2567');
      expect(liveYearClose(st, CO, 2025)).toBeUndefined();
      closeYear(st, CO, 2024, ME);
      expect(() => closeYear(st, CO, 2025, ME)).not.toThrow();
    });
    it('reopenYear refuses while a later year is closed', () => {
      with2024();
      closeYear(st, CO, 2024, ME);
      closeYear(st, CO, 2025, ME);
      const e = err(() => reopenYear(st, CO, 2024, ME, 'r'));
      expect(e.code).toBe('period.year_order');
      expect(e.title).toContain('2568');
      expect(liveYearClose(st, CO, 2024)).toBeDefined();
      reopenYear(st, CO, 2025, ME, 'r');
      expect(() => reopenYear(st, CO, 2024, ME, 'r')).not.toThrow();
    });
  });

  describe('kept as built (ruling 7)', () => {
    it('a notes-only edit of a closed-year document stays refused', () => {
      const j = in2025(() => jv('2025-06-15', [L('5110', '100.00', '0.00'), L('2120', '0.00', '100.00')]));
      closeYear(st, CO, 2025, ME);
      expect(err(() => revise(st, j.id, { header: { ...j.header, notes: 'only notes' }, lines: j.lines }, j.version, 'x', ME)).code).toBe('period.year_closed');
    });
    it('a year with no P&L closes into an empty entry', () => {
      expect(closeYear(st, 'co-nonvat', 2025, ME).journal[0].lines).toEqual([]);
    });
  });
});
