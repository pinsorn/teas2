import { beforeEach, describe, expect, it } from 'vitest';
import type { Actor, DocLine } from '@/domain/types';
import type { ReportModel, ReportRow } from '@/domain/reports';
import { buildSeedState, type MockState } from '../../store';
import { createDraft, issue } from '../commands';
import { closeYear } from '../close';
import { checkInvariants } from '../invariants';
import { withFixedClock } from '../log';
import { toSatang } from '../money';
import { compareRange, netProfit, netProfitRange } from './profit-loss';
import { profitLoss } from './profit-loss';
import { trialBalance } from './trial-balance';

const ME: Actor = { kind: 'user', id: 'u-1', name: 'สมศรี บัญชีดี' };
const VAT = 'co-vat', NV = 'co-nonvat';
let st: MockState, n = 0;
beforeEach(() => { st = buildSeedState(); });

/** The test's own oracle: raw journal lines straight from the stores (never through companyEntries / balances), closing entries kept apart. */
const raw = (s: MockState, co: string, closing: boolean) => [
  ...s.journals.filter((j) => s.docs.some((d) => d.id === j.docId && d.companyId === co)).flatMap((j) => j.preview.entries),
  ...s.bankJournals.filter((j) => j.companyId === co).flatMap((j) => j.entries),
  ...s.settlements.filter((x) => x.companyId === co).flatMap((x) => x.journal),
  ...s.filings.filter((f) => f.companyId === co).flatMap((f) => f.journal ?? []),
  ...(closing ? s.yearCloses.filter((y) => y.companyId === co).flatMap((y) => y.journal) : []),
];
/** Σ revenue - Σ expense (satang) of the entries dated from..to, closing entries out; revenue / expense = codes 4xxx / 5xxx. */
const oracleProfit = (s: MockState, co: string, from: string, to: string, dim?: (d: Record<string, string> | undefined) => boolean) => 0 -
  raw(s, co, false).filter((e) => e.date >= from && e.date <= to).flatMap((e) => e.lines).filter((l) => /^[45]/.test(l.accountCode) && (!dim || dim(l.dimensions)))
    .reduce((a, l) => a + toSatang(l.debit) - toSatang(l.credit), 0);
const net = (m: ReportModel, key = 'cur') => { const r = m.rows.find((x) => x.kind === 'total'); return r ? toSatang(r.cells[key]) : 0; }; // no row = no activity
const L = (code: string, debit: string, credit: string, dimensions?: Record<string, string>): DocLine =>
  ({ id: `pl-${++n}`, description: `รายการ ${code}`, qty: '1', unit: '', unitPrice: '0.00', taxCode: 'EX', accountCode: code, debit, credit, ...(dimensions ? { dimensions } : {}) });
const jv = (date: string, lines: DocLine[], co = VAT) => withFixedClock(`${date}T10:00:00+07:00`, () => { const d = createDraft(st, co, 'JV', { header: { documentDate: date }, lines }, ME, `pl${++n}`); return issue(st, d.id, d.version, ME); });
/** Close 2025 for the VAT company: its months are closed in the seed, so the year-end entry can be written. */
const close2025 = () => closeYear(st, VAT, 2025, ME);
const cell = (r: ReportRow, key: string) => r.cells[key];
const acct = (m: ReportModel, code: string) => m.rows.find((r) => r.kind === 'row' && r.cells.code === code);

describe('ruling 1: one source for profit', () => {
  it.each([VAT, NV])('a whole calendar year: report net profit = netProfit(year) = the raw-line oracle (%s)', (co) => {
    for (const year of [2025, 2026]) {
      const m = profitLoss(st, co, { from: `${year}-01-01`, to: `${year}-12-31` });
      expect(net(m)).toBe(netProfit(st, co, year));
      expect(net(m)).toBe(oracleProfit(st, co, `${year}-01-01`, `${year}-12-31`));
      if (m.rows.length) expect(m.tieOuts![0].diff).toBe('0.00'); else expect(m.tieOuts).toEqual([]);
    }
  });
  it('1 Jan..through = netProfit(year, through)', () => {
    for (const through of ['2026-03-31', '2026-06-30', '2026-09-30']) {
      const m = profitLoss(st, VAT, { from: '2026-01-01', to: through });
      expect(net(m)).toBe(netProfit(st, VAT, 2026, through));
      expect(net(m)).toBe(oracleProfit(st, VAT, '2026-01-01', through));
    }
    expect(netProfit(st, VAT, 2026, '2026-06-30')).not.toBe(0);
  });
  it('a range may cross a year boundary: the sum of its parts', () => {
    const m = profitLoss(st, VAT, { from: '2025-07-01', to: '2026-06-30' });
    expect(net(m)).toBe(oracleProfit(st, VAT, '2025-07-01', '2026-06-30'));
    expect(net(m)).toBe(netProfitRange(st, VAT, '2025-07-01', '2025-12-31') + netProfitRange(st, VAT, '2026-01-01', '2026-06-30'));
  });
  it('a CLOSED year still reports its profit: the year-end entries are left out', () => {
    const before = net(profitLoss(st, VAT, { from: '2025-01-01', to: '2025-12-31' }));
    expect(before).not.toBe(0);
    close2025();
    const m = profitLoss(st, VAT, { from: '2025-01-01', to: '2025-12-31' });
    expect(net(m)).toBe(before);
    expect(net(m)).toBe(netProfit(st, VAT, 2025));
    expect(m.tieOuts![0].diff).toBe('0.00');
  });
  it('the tie-out shows a dropped account as a difference, never hides it', () => {
    const m = profitLoss(st, VAT, { from: '2026-01-01', to: '2026-12-31' });
    const t = m.tieOuts![0];
    expect(t.left).toBe(t.right);
    expect(toSatang(t.right)).toBe(netProfitRange(st, VAT, '2026-01-01', '2026-12-31'));
  });
});

describe('ruling 2: rows, gross profit, drill-down', () => {
  it('rows by class in §5.4 order with accounts under each, subtotals = Σ accounts, gross profit and net profit', () => {
    const m = profitLoss(st, VAT, { from: '2026-01-01', to: '2026-12-31' });
    const groups = m.rows.filter((r) => r.kind === 'group').map((r) => r.cells.name);
    expect(groups.slice(0, 2)).toEqual(['รายได้จากการขายและบริการ', 'ต้นทุนขายและบริการ']);
    expect(groups.some((g) => g.includes('ค่าใช้จ่ายในการขายและบริหาร'))).toBe(true);
    let sum = 0;
    for (const r of m.rows) {
      if (r.kind === 'row') sum += toSatang(r.cells.cur);
      if (r.kind === 'subtotal' && !r.cells.name.startsWith('กำไร')) { expect(toSatang(r.cells.cur)).toBe(sum); sum = 0; }
    }
    const rev = m.rows.find((r) => r.kind === 'subtotal' && r.cells.name === 'รายได้จากการขายและบริการ')!;
    const cogs = m.rows.find((r) => r.kind === 'subtotal' && r.cells.name === 'ต้นทุนขายและบริการ')!;
    const gross = m.rows.find((r) => r.kind === 'subtotal' && r.cells.name.startsWith('กำไรขั้นต้น'))!;
    expect(toSatang(gross.cells.cur)).toBe(toSatang(rev.cells.cur) - toSatang(cogs.cells.cur));
    expect(m.rows.at(-1)!.kind).toBe('total');
  });
  it('a contra-revenue account shows negative under revenue, an expense positive', () => {
    jv('2026-08-20', [L('4110', '500.00', '0.00'), L('2120', '0.00', '500.00')]);
    const m = profitLoss(st, VAT, { from: '2026-08-01', to: '2026-08-31' });
    const was = profitLoss(buildSeedState(), VAT, { from: '2026-08-01', to: '2026-08-31' });
    expect(toSatang(cell(acct(m, '4110')!, 'cur')) - toSatang(acct(was, '4110') ? cell(acct(was, '4110')!, 'cur') : '0.00')).toBe(-50000);
    expect(toSatang(cell(acct(m, '4110')!, 'cur'))).toBeLessThan(0);
  });
  it('each account row links to the GL with the same range', () => {
    const m = profitLoss(st, VAT, { from: '2026-02-01', to: '2026-09-30' });
    const row = acct(m, '4100')!;
    expect(row.href).toBe('/reports/financial-statements?tab=gl&account=4100&from=2026-02-01&to=2026-09-30');
  });
  it('comparative previous = the range of equal length just before from; lastYear = the same dates a year earlier', () => {
    expect(compareRange('2026-03-01', '2026-03-31', 'previous')).toEqual({ from: '2026-01-29', to: '2026-02-28' });
    expect(compareRange('2026-01-01', '2026-12-31', 'previous')).toEqual({ from: '2025-01-01', to: '2025-12-31' });
    expect(compareRange('2028-02-29', '2028-03-31', 'lastYear')).toEqual({ from: '2027-02-28', to: '2027-03-31' });
    expect(compareRange('2027-01-01', '2028-02-29', 'lastYear')).toEqual({ from: '2026-01-01', to: '2027-02-28' });
  });
  it('comparative columns carry the other range and the difference', () => {
    const used = new Set(profitLoss(st, VAT, { from: '2026-07-01', to: '2026-09-30' }).rows.filter((r) => r.kind === 'row').map((r) => r.cells.code));
    const only = ['5150', '5160', '5170', '5180', '5300', '5500'].find((c) => !used.has(c))!;
    jv('2026-05-10', [L(only, '70.00', '0.00'), L('2120', '0.00', '70.00')]); // a account the later range never touches
    const m = profitLoss(st, VAT, { from: '2026-07-01', to: '2026-09-30', compare: 'previous' });
    expect(m.columns.map((c) => c.key)).toEqual(['code', 'name', 'cur', 'cmp', 'diff']);
    expect(m.params.compare).toBe('previous');
    const prev = compareRange('2026-07-01', '2026-09-30', 'previous');
    expect(net(m, 'cmp')).toBe(oracleProfit(st, VAT, prev.from, prev.to));
    expect(net(m, 'cur')).toBe(oracleProfit(st, VAT, '2026-07-01', '2026-09-30'));
    for (const r of m.rows.filter((x) => x.cells.cur !== undefined && x.cells.cur !== '')) expect(toSatang(r.cells.diff)).toBe(toSatang(r.cells.cur) - toSatang(r.cells.cmp || '0.00'));
    // an account that only the other range has still gets its row
    expect(toSatang(acct(m, only)!.cells.cur)).toBe(0);
    expect(toSatang(acct(m, only)!.cells.cmp)).toBe(7000);
    const ly = profitLoss(st, VAT, { from: '2026-07-01', to: '2026-09-30', compare: 'lastYear' });
    expect(net(ly, 'cmp')).toBe(oracleProfit(st, VAT, '2025-07-01', '2025-09-30'));
  });
});

describe('DBD format 2.7 [SP-R]', () => {
  it('groups by the account mapping; the net profit does not change', () => {
    const by = profitLoss(st, VAT, { from: '2026-01-01', to: '2026-12-31' });
    const dbd = profitLoss(st, VAT, { from: '2026-01-01', to: '2026-12-31', format: 'dbd' });
    expect(net(dbd)).toBe(net(by));
    expect(dbd.rows.some((r) => r.kind === 'group' && r.cells.name.includes('รายได้จากการขายหรือการให้บริการ'))).toBe(true);
    expect(dbd.rows.some((r) => r.cells.name.includes('ยังไม่จัดกลุ่ม'))).toBe(false);
    expect(dbd.tieOuts![0].diff).toBe('0.00');
  });
  it('an unmapped account with a balance appears under "ยังไม่จัดกลุ่ม", never dropped', () => {
    for (const a of st.accounts) if (a.companyId === VAT && (a.code === '5110' || a.code === '4100')) delete a.dbdLine;
    const dbd = profitLoss(st, VAT, { from: '2026-01-01', to: '2026-12-31', format: 'dbd' });
    const i = dbd.rows.findIndex((r) => r.kind === 'group' && r.cells.name.includes('ยังไม่จัดกลุ่ม'));
    expect(i).toBeGreaterThan(-1);
    expect(dbd.rows.filter((r) => r.kind === 'row').map((r) => r.cells.code)).toEqual(expect.arrayContaining(['5110', '4100']));
    expect(net(dbd)).toBe(oracleProfit(st, VAT, '2026-01-01', '2026-12-31'));
    expect(dbd.tieOuts![0].diff).toBe('0.00');
  });
});

describe('ruling 5: dimension columns', () => {
  it('the seed has dimension-tagged entries (project P-A / P-B) and still passes the invariants', () => {
    expect(checkInvariants(st)).toEqual([]);
    const m = profitLoss(st, NV, { from: '2026-01-01', to: '2026-12-31', groupBy: 'project' });
    expect(m.columns.map((c) => c.label ?? c.key)).toEqual(expect.arrayContaining(['P-A', 'P-B', 'ไม่ระบุ']));
  });
  it('one column per value plus "ไม่ระบุ"; every row: Σ columns = the total column; each column = the raw-line oracle', () => {
    jv('2026-08-10', [L('5110', '100.00', '0.00', { project: 'P-A' }), L('5120', '60.00', '0.00', { project: 'P-B' }), L('5140', '40.00', '0.00'), L('2120', '0.00', '200.00', { project: 'P-A' })]);
    const m = profitLoss(st, VAT, { from: '2026-01-01', to: '2026-12-31', groupBy: 'project' });
    const dims = m.columns.filter((c) => c.key.startsWith('dim'));
    expect(dims.map((c) => c.label)).toEqual(['P-A', 'P-B', 'ไม่ระบุ']);
    for (const r of m.rows.filter((x) => x.cells.total !== undefined && x.cells.total !== '')) {
      expect(dims.reduce((a, c) => a + toSatang(r.cells[c.key] || '0.00'), 0)).toBe(toSatang(r.cells.total));
    }
    expect(net(m, 'total')).toBe(oracleProfit(st, VAT, '2026-01-01', '2026-12-31'));
    expect(net(m, 'dim:P-A')).toBe(oracleProfit(st, VAT, '2026-01-01', '2026-12-31', (d) => d?.project === 'P-A'));
    expect(net(m, 'dim:P-B')).toBe(oracleProfit(st, VAT, '2026-01-01', '2026-12-31', (d) => d?.project === 'P-B'));
    expect(net(m, 'dimNone')).toBe(oracleProfit(st, VAT, '2026-01-01', '2026-12-31', (d) => !d?.project));
    expect(m.tieOuts!.every((t) => t.diff === '0.00')).toBe(true);
  });
  it('a dimension drill-down link carries the value; the "ไม่ระบุ" column has none', () => {
    jv('2026-08-10', [L('5110', '100.00', '0.00', { project: 'P-A' }), L('2120', '0.00', '100.00')]);
    const m = profitLoss(st, VAT, { from: '2026-08-01', to: '2026-08-31', groupBy: 'project' });
    const r = acct(m, '5110')!;
    expect(r.links?.['dim:P-A']).toBe('/reports/financial-statements?tab=gl&account=5110&from=2026-08-01&to=2026-08-31&dimension=project%3AP-A');
    expect(r.links?.dimNone).toBeUndefined();
  });
  it('groupBy together with a comparative is refused with a stated reason', () => {
    expect(() => profitLoss(st, VAT, { from: '2026-01-01', to: '2026-12-31', groupBy: 'project', compare: 'previous' })).toThrow(expect.objectContaining({ status: 422, code: 'report.bad_param' }));
  });
  it('the trial balance groupBy adds one net column per value; Σ columns = debit - credit per row; per-column totals are shown, not forced to balance', () => {
    jv('2026-08-10', [L('5110', '100.00', '0.00', { project: 'P-A' }), L('2120', '0.00', '100.00', { project: 'P-B' })]);
    const m = trialBalance(st, VAT, { asOf: '2026-12-31', groupBy: 'project' });
    const dims = m.columns.filter((c) => c.key.startsWith('dim'));
    expect(dims.map((c) => c.label)).toEqual(['P-A', 'P-B', 'ไม่ระบุ']);
    for (const r of m.rows.filter((x) => x.kind === 'row')) expect(dims.reduce((a, c) => a + toSatang(r.cells[c.key] || '0.00'), 0)).toBe(toSatang(r.cells.debit) - toSatang(r.cells.credit));
    const total = m.rows.find((r) => r.kind === 'total')!;
    expect(toSatang(total.cells['dim:P-A'])).toBe(10000); // P-A holds a debit of 100 with no credit: the column is NOT balanced, and says so
    expect(toSatang(total.cells['dim:P-B'])).toBe(-10000);
    expect(m.tieOuts![0].diff).toBe('0.00');
    expect(m.tieOuts!.every((t) => t.diff === '0.00')).toBe(true);
    expect(trialBalance(st, VAT, { asOf: '2026-12-31' }).columns.map((c) => c.key)).toEqual(['code', 'name', 'debit', 'credit']);
  });
  it('the trial balance rows drill into the GL tab', () => {
    const m = trialBalance(st, VAT, { asOf: '2026-09-30' });
    expect(m.rows[0].href).toBe(`/reports/financial-statements?tab=gl&account=${m.rows[0].cells.code}&to=2026-09-30`);
  });
});

