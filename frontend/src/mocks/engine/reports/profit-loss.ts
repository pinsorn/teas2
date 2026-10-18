import type { ReportModel, ReportRow } from '@/domain/reports';
import { GROUP_OF, type AccountClass } from '@/records/accounts';
import { formatDateBE } from '@/lib/format';
import type { MockState } from '../../store';
import { companyEntries } from '../ledger';
import { fromSatang, toSatang } from '../money';
import { type Acct, GROSS_PROFIT_TH, NET_PROFIT_TH, NO_DIM_TH, PL_CLASSES, type Sec, badParam, classSections, dbdSections, glLink, money, needDate, sectionRows, secTotal, sumV } from './statement-lines';

// The ONE place a period's profit is added up (I12): the year-end closing entry (close.ts), the ภ.ง.ด.50 / 51 (filings/cit.ts) and the P&L report all read it. The fiscal year is the calendar year (fiscalYearStartMonth 1).
// Reports are live views of the GL: nothing here is frozen at issue (the freeze rule is about documents and filings).

/** Σ debit - Σ credit (satang) per account, and per value of the dimension type `by` ('' = a line without it), of the entries dated from..to ('' = unbounded); `closing` false leaves the year-end entries out (what they close). */
export function rangeBalances(st: MockState, companyId: string, from: string, to: string, closing: boolean, by?: string): Map<string, Map<string, number>> {
  const m = new Map<string, Map<string, number>>();
  for (const e of companyEntries(st, companyId, closing)) {
    if (e.date < from || (to && e.date > to)) continue;
    for (const l of e.lines) {
      const per = m.get(l.accountCode) ?? new Map<string, number>(), key = by ? l.dimensions?.[by] ?? '' : '';
      per.set(key, (per.get(key) ?? 0) + toSatang(l.debit) - toSatang(l.credit));
      m.set(l.accountCode, per);
    }
  }
  return m;
}
/** The same, one number per account. */
export function balancesRange(st: MockState, companyId: string, from: string, to: string, closing: boolean): Map<string, number> {
  return new Map([...rangeBalances(st, companyId, from, to, closing)].map(([c, per]) => [c, [...per.values()].reduce((a, b) => a + b, 0)]));
}
/** Σ debit - Σ credit (satang) per account of the entries dated in `year` (up to `through`); `closing` false leaves the year-end entries out (what they close). */
export const balances = (st: MockState, companyId: string, year: number, closing: boolean, through = `${year}-12-31`): Map<string, number> =>
  balancesRange(st, companyId, `${year}-01-01`, through < `${year}-12-31` ? through : `${year}-12-31`, closing);

const classOf = (st: MockState, companyId: string, code: string) => st.accounts.find((x) => x.companyId === companyId && x.code === code)?.class;
export const isPl = (st: MockState, companyId: string, code: string) => { const c = classOf(st, companyId, code); return !!c && ['revenue', 'expense'].includes(GROUP_OF[c]); };
/** The revenue / expense accounts with a balance, by code. */
export const plOf = (st: MockState, companyId: string, m: Map<string, number>): [string, number][] => [...m].filter(([c, v]) => v !== 0 && isPl(st, companyId, c)).sort(([a], [b]) => a.localeCompare(b));
/** A period's profit in satang (negative = loss): Σ revenue - Σ expense of the entries dated from..to, closing entries left out. */
export const netProfitRange = (st: MockState, companyId: string, from: string, to: string): number => 0 - plOf(st, companyId, balancesRange(st, companyId, from, to, false)).reduce((n, [, v]) => n + v, 0);
/** The year's profit in satang (negative = loss): Σ revenue - Σ expense, closing entries left out, optionally only up to `through` (the half year of a ภ.ง.ด.51). */
export const netProfit = (st: MockState, companyId: string, year: number, through?: string): number =>
  netProfitRange(st, companyId, `${year}-01-01`, through && through < `${year}-12-31` ? through : `${year}-12-31`);

// ---------------------------------------------------------------- comparative ranges

const DAY = 86_400_000;
const ms = (d: string) => Date.parse(`${d}T00:00:00Z`);
export const addDays = (d: string, n: number) => new Date(ms(d) + n * DAY).toISOString().slice(0, 10);
/** The same date a year earlier; 29 Feb has no twin in a common year and falls on 28 Feb. */
export const yearBack = (d: string): string => {
  const y = Number(d.slice(0, 4)) - 1, last = new Date(Date.UTC(y, Number(d.slice(5, 7)), 0)).getUTCDate();
  return `${y}${d.slice(4, 8)}${String(Math.min(Number(d.slice(8, 10)), last)).padStart(2, '0')}`;
};
/** previous = the range of equal length (in days) just before `from`; lastYear = the same dates one year earlier. */
export function compareRange(from: string, to: string, mode: 'previous' | 'lastYear'): { from: string; to: string } {
  if (mode === 'lastYear') return { from: yearBack(from), to: yearBack(to) };
  const days = Math.round((ms(to) - ms(from)) / DAY) + 1, end = addDays(from, -1);
  return { from: addDays(end, -(days - 1)), to: end };
}

// ---------------------------------------------------------------- the report

export interface PlParams { from?: string; to?: string; compare?: string; groupBy?: string; format?: string }
/** One amount column: `get` = Σ debit - Σ credit of an account in it, `net` = the column's profit. */
interface Col { key: string; labelKey: string; label?: string; get: (code: string) => number; net: number; dimension?: string }

/** ReportModel `profit-loss`: the revenue / expense accounts by class (§5.4) or by DBD line (format 2.7 [SP-R]), gross profit, net profit; optional comparative columns or one column per value of a dimension type (not both). */
export function profitLoss(st: MockState, companyId: string, p: PlParams): ReportModel {
  const from = needDate('from', p.from), to = needDate('to', p.to), cmpMode = p.compare ?? '', by = p.groupBy?.trim() ?? '', dbd = p.format === 'dbd';
  if (from > to) throw badParam('วันที่เริ่มต้นต้องไม่หลังวันที่สิ้นสุด');
  if (cmpMode && cmpMode !== 'previous' && cmpMode !== 'lastYear') throw badParam('ตัวเลือกเปรียบเทียบไม่ถูกต้อง');
  if (p.format && !dbd) throw badParam('รูปแบบงบไม่ถูกต้อง');
  if (by && cmpMode) throw badParam('เลือกเปรียบเทียบหรือจัดกลุ่มตามมิติอย่างใดอย่างหนึ่ง');

  const cols: Col[] = [], notes: string[] = [];
  const range = (key: string, labelKey: string, f: string, t: string): Col => {
    const m = balancesRange(st, companyId, f, t, false);
    return { key, labelKey, get: (c) => m.get(c) ?? 0, net: netProfitRange(st, companyId, f, t) };
  };
  if (by) {
    const per = rangeBalances(st, companyId, from, to, false, by);
    const vals = [...new Set([...per.values()].flatMap((m) => [...m.keys()]))].filter(Boolean).sort();
    const one = (v: string): Col => ({ key: v ? `dim:${v}` : 'dimNone', labelKey: 'reports.pl.cur', label: v || NO_DIM_TH, ...(v ? { dimension: `${by}:${v}` } : {}),
      get: (c) => per.get(c)?.get(v) ?? 0, net: -[...per].filter(([c]) => isPl(st, companyId, c)).reduce((a, [, m]) => a + (m.get(v) ?? 0), 0) });
    cols.push(...vals.map(one), one(''), range('total', 'reports.pl.total', from, to));
  } else {
    cols.push(range('cur', 'reports.pl.cur', from, to));
    if (cmpMode) {
      const r = compareRange(from, to, cmpMode as 'previous' | 'lastYear'); // validated above
      cols.push(range('cmp', 'reports.pl.cmp', r.from, r.to));
      notes.push(`งวดเปรียบเทียบ: ${formatDateBE(r.from)} ถึง ${formatDateBE(r.to)}`);
    }
  }
  const diff = !!cmpMode, keys = [...cols.map((c) => c.key), ...(diff ? ['diff'] : [])], n = keys.length;
  const ext = (v: number[]) => (diff ? [...v, v[0] - v[1]] : v);

  // every revenue / expense account with a balance in any column - closing entries are left out, so a closed year still reports its profit
  const accts: Acct[] = st.accounts.filter((a) => a.companyId === companyId && isPl(st, companyId, a.code) && cols.some((c) => c.get(a.code) !== 0)).sort((a, b) => a.code.localeCompare(b.code)).map((a) => {
    const g = GROUP_OF[a.class], sgn = g === 'revenue' ? -1 : 1;
    return { code: a.code, name: a.nameTh, group: g, ...(a.dbdLine ? { dbdLine: a.dbdLine } : {}), v: ext(cols.map((c) => sgn * c.get(a.code))) };
  });
  const secs: Sec[] = dbd ? dbdSections(accts, 'pl') : classSections(accts, (c) => classOf(st, companyId, c) as AccountClass, PL_CLASSES);

  const link = {
    href: (code: string) => glLink(code, { from, to }),
    ...(by ? { cell: (code: string, key: string) => { const d = cols.find((c) => c.key === key)?.dimension; return d ? glLink(code, { from, to, dimension: d }) : undefined; } } : {}),
  };
  const sales = secs.find((s) => s.tag === 'sales'), cogs = secs.find((s) => s.tag === 'cogs');
  const gross = sumV([sales ? secTotal(sales, n) : [], cogs ? secTotal(cogs, n).map((x) => -x) : []], n);
  const rows: ReportRow[] = [];
  for (const s of secs) {
    rows.push(...sectionRows(s, keys, link));
    if (s === (cogs ?? sales)) rows.push({ level: 0, kind: 'subtotal', cells: { code: '', name: GROSS_PROFIT_TH, ...money(keys, gross) } });
  }
  // net profit: the figure of netProfitRange itself (the one source) per column - a dimension column is its own lines' sum. The tie-out sets it against the accounts shown.
  const nets = ext(cols.map((c) => c.net));
  const shown = ext(cols.map((_, i) => accts.reduce((a, x) => a + (x.group === 'revenue' ? x.v[i] : -x.v[i]), 0)));
  if (rows.length) rows.push({ level: 0, kind: 'total', cells: { code: '', name: NET_PROFIT_TH, ...money(keys, nets) } });
  const tie = (key: string) => { const i = keys.indexOf(key); return { labelKey: 'reports.pl.tie', left: fromSatang(shown[i]), right: fromSatang(nets[i]), diff: fromSatang(shown[i] - nets[i]) }; };
  return {
    kind: 'profit-loss', titleKey: 'reports.pl.title', params: Object.fromEntries(Object.entries({ from, to, compare: cmpMode, groupBy: by, format: p.format ?? '' }).filter(([, v]) => v)),
    columns: [{ key: 'code', labelKey: 'reports.tb.code', kind: 'text' }, { key: 'name', labelKey: 'reports.tb.name', kind: 'text' },
      ...cols.map((c) => ({ key: c.key, labelKey: c.labelKey, ...(c.label ? { label: c.label } : {}), kind: 'money' as const, align: 'end' as const })),
      ...(diff ? [{ key: 'diff', labelKey: 'reports.pl.diff', kind: 'money' as const, align: 'end' as const }] : [])],
    rows,
    tieOuts: rows.length ? [tie(by ? 'total' : 'cur'), ...(diff ? [tie('cmp')] : [])] : [],
    ...(notes.length ? { notes } : {}),
  };
}
