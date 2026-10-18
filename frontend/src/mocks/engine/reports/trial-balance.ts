import type { ReportModel, ReportRow } from '@/domain/reports';
import type { MockState } from '../../store';
import { companyEntries } from '../ledger';
import { fromSatang, toSatang } from '../money';
import { NO_DIM_TH, glLink } from './statement-lines';

export interface TbParams { asOf?: string; dimension?: string; includeZero?: string; groupBy?: string }

/** Trial balance from the company's journal lines up to `asOf`, in integer satang. The tie-out is computed from the same lines but is NOT
 *  forced to balance: a corrupted journal shows up as a non-zero `diff` (the banner), it is never hidden here. */
export function trialBalance(st: MockState, companyId: string, p: TbParams & { asOf: string }): ReportModel {
  const [dimType, ...dimRest] = (p.dimension ?? '').split(':');
  const dimValue = dimRest.join(':');
  const by = p.groupBy?.trim() ?? '';
  const net = new Map<string, { name: string; sat: number; per: Map<string, number> }>();
  const accounts = st.accounts.filter((a) => a.companyId === companyId && a.postable);
  if (p.includeZero === 'true') for (const a of accounts) net.set(a.code, { name: a.nameTh, sat: 0, per: new Map() });
  for (const e of companyEntries(st, companyId)) { // documents' journals and the reconciliation's own
    if (e.date > p.asOf) continue;
    for (const l of e.lines) {
      if (dimType && l.dimensions?.[dimType] !== dimValue) continue;
      const cur = net.get(l.accountCode) ?? { name: accounts.find((a) => a.code === l.accountCode)?.nameTh ?? l.accountName, sat: 0, per: new Map<string, number>() };
      const amt = toSatang(l.debit) - toSatang(l.credit), v = by ? l.dimensions?.[by] ?? '' : '';
      cur.sat += amt;
      if (by) cur.per.set(v, (cur.per.get(v) ?? 0) + amt);
      net.set(l.accountCode, cur);
    }
  }
  // groupBy: one signed net column (debit +, credit -) per value of the dimension type, "ไม่ระบุ" for lines without it; their sum is the row's debit - credit. A column need not balance on its own (an entry's lines may carry different values).
  const vals = [...new Set([...net.values()].flatMap((v) => [...v.per.keys()]))].sort((a, b) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)));
  const dimKey = (v: string) => (v ? `dim:${v}` : 'dimNone');
  const colTotal = new Map<string, number>();
  let dr = 0, cr = 0;
  const rows: ReportRow[] = [...net].sort(([a], [b]) => a.localeCompare(b)).map(([code, v]) => {
    const d = Math.max(v.sat, 0), c = Math.max(-v.sat, 0);
    dr += d; cr += c;
    for (const x of vals) colTotal.set(x, (colTotal.get(x) ?? 0) + (v.per.get(x) ?? 0));
    return { level: 0, kind: 'row', cells: { code, name: v.name, debit: fromSatang(d), credit: fromSatang(c), ...Object.fromEntries(vals.map((x) => [dimKey(x), fromSatang(v.per.get(x) ?? 0)])) },
      href: glLink(code, { to: p.asOf }), ...(by ? { links: Object.fromEntries(vals.filter(Boolean).map((x) => [dimKey(x), glLink(code, { to: p.asOf, dimension: `${by}:${x}` })])) } : {}) };
  });
  if (rows.length) rows.push({ level: 0, kind: 'total', cells: { code: '', name: '', debit: fromSatang(dr), credit: fromSatang(cr), ...Object.fromEntries(vals.map((x) => [dimKey(x), fromSatang(colTotal.get(x) ?? 0)])) } });
  const colSum = [...colTotal.values()].reduce((a, b) => a + b, 0);
  return {
    kind: 'trial-balance', titleKey: 'reports.tb.title', asOf: p.asOf,
    params: { asOf: p.asOf, ...(p.dimension ? { dimension: p.dimension } : {}), ...(p.includeZero ? { includeZero: p.includeZero } : {}), ...(by ? { groupBy: by } : {}) },
    columns: [
      { key: 'code', labelKey: 'reports.tb.code', kind: 'text' }, { key: 'name', labelKey: 'reports.tb.name', kind: 'text' },
      { key: 'debit', labelKey: 'reports.tb.debit', kind: 'money', align: 'end' }, { key: 'credit', labelKey: 'reports.tb.credit', kind: 'money', align: 'end' },
      ...vals.map((x) => ({ key: dimKey(x), labelKey: 'reports.tb.net', label: x || NO_DIM_TH, kind: 'money' as const, align: 'end' as const })),
    ],
    rows,
    tieOuts: [{ labelKey: 'reports.tb.balanced', left: fromSatang(dr), right: fromSatang(cr), diff: fromSatang(dr - cr) },
      ...(by ? [{ labelKey: 'reports.tb.columns', left: fromSatang(colSum), right: fromSatang(dr - cr), diff: fromSatang(colSum - (dr - cr)) }] : [])],
  };
}
