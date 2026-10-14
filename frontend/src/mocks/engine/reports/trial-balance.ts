import type { ReportModel, ReportRow } from '@/domain/reports';
import type { MockState } from '../../store';
import { fromSatang, toSatang } from '../money';

export interface TbParams { asOf?: string; dimension?: string; includeZero?: string }

/** Trial balance from the company's journal lines up to `asOf`, in integer satang. The tie-out is computed from the same lines but is NOT
 *  forced to balance: a corrupted journal shows up as a non-zero `diff` (the banner), it is never hidden here. */
export function trialBalance(st: MockState, companyId: string, p: TbParams & { asOf: string }): ReportModel {
  const mine = new Set(st.docs.filter((d) => d.companyId === companyId).map((d) => d.id));
  const [dimType, ...dimRest] = (p.dimension ?? '').split(':');
  const dimValue = dimRest.join(':');
  const net = new Map<string, { name: string; sat: number }>();
  const accounts = st.accounts.filter((a) => a.companyId === companyId && a.postable);
  if (p.includeZero === 'true') for (const a of accounts) net.set(a.code, { name: a.nameTh, sat: 0 });
  for (const j of st.journals) {
    if (!mine.has(j.docId)) continue;
    for (const e of j.preview.entries) {
      if (e.date > p.asOf) continue;
      for (const l of e.lines) {
        if (dimType && l.dimensions?.[dimType] !== dimValue) continue;
        const cur = net.get(l.accountCode) ?? { name: accounts.find((a) => a.code === l.accountCode)?.nameTh ?? l.accountName, sat: 0 };
        cur.sat += toSatang(l.debit) - toSatang(l.credit);
        net.set(l.accountCode, cur);
      }
    }
  }
  let dr = 0, cr = 0;
  const rows: ReportRow[] = [...net].sort(([a], [b]) => a.localeCompare(b)).map(([code, v]) => {
    const d = Math.max(v.sat, 0), c = Math.max(-v.sat, 0);
    dr += d; cr += c;
    return { level: 0, kind: 'row', cells: { code, name: v.name, debit: fromSatang(d), credit: fromSatang(c) }, href: `/reports/general-ledger?account=${code}` };
  });
  if (rows.length) rows.push({ level: 0, kind: 'total', cells: { code: '', name: '', debit: fromSatang(dr), credit: fromSatang(cr) } });
  return {
    kind: 'trial-balance', titleKey: 'reports.tb.title', asOf: p.asOf,
    params: { asOf: p.asOf, ...(p.dimension ? { dimension: p.dimension } : {}), ...(p.includeZero ? { includeZero: p.includeZero } : {}) },
    columns: [
      { key: 'code', labelKey: 'reports.tb.code', kind: 'text' }, { key: 'name', labelKey: 'reports.tb.name', kind: 'text' },
      { key: 'debit', labelKey: 'reports.tb.debit', kind: 'money', align: 'end' }, { key: 'credit', labelKey: 'reports.tb.credit', kind: 'money', align: 'end' },
    ],
    rows,
    tieOuts: [{ labelKey: 'reports.tb.balanced', left: fromSatang(dr), right: fromSatang(cr), diff: fromSatang(dr - cr) }],
  };
}
