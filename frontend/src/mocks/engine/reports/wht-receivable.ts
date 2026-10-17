import { docViewHref } from '@/descriptors';
import { LIVE } from '@/domain/doc-types';
import type { ReportColumn, ReportModel, ReportRow } from '@/domain/reports';
import type { MockState } from '../../store';
import { companyEntries } from '../ledger';
import { fromSatang, toSatang } from '../money';
import { monthLabelTh } from '../periods';
import { resolveRole } from '../posting';

export interface WhtAlloc { rcId: string; number: string; date: string; customer: string; target: string; cert: string; wht: number }
/** Every allocation of a live receipt that withheld tax, oldest first (the customer is the party of the receipt; the target is the invoice the tax was withheld from). */
export function whtAllocations(st: MockState, companyId: string, asOf?: string): WhtAlloc[] {
  return st.docs.filter((d) => d.companyId === companyId && d.type === 'RC' && LIVE.includes(d.status) && (!asOf || d.header.documentDate <= asOf))
    .flatMap((d) => (d.allocations ?? []).filter((a) => toSatang(a.wht ?? '0.00') > 0).map((a) => ({
      rcId: d.id, number: d.number ?? d.id, date: d.header.documentDate, customer: d.party?.name ?? '', target: a.targetNumber ?? a.targetId, cert: (a.certNumber ?? '').trim(), wht: toSatang(a.wht!),
    })))
    .sort((a, b) => a.date.localeCompare(b.date) || a.number.localeCompare(b.number));
}
const days = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
const text = (key: string, align?: 'end'): ReportColumn => ({ key, labelKey: `reports.whtRec.${key}`, kind: 'text', ...(align ? { align } : {}) });
const money = (key: string): ReportColumn => ({ key, labelKey: `reports.whtRec.${key}`, kind: 'money', align: 'end' });
const BUCKETS = ['d0', 'd31', 'd61', 'd90'] as const;
const bucket = (age: number) => BUCKETS[age > 90 ? 3 : age > 60 ? 2 : age > 30 ? 1 : 0];

/** ภาษีถูกหัก ณ ที่จ่าย (TX2b): the tax customers withheld, by month of the receipt, with the certificate number, aged by days since the receipt as of `asOf` (0-30 / 31-60 / 61-90 / over 90).
 *  Tie-out: Σ = the GL balance of the WhtReceivable account (1180) up to `asOf`. */
export function whtReceivable(st: MockState, companyId: string, p: { asOf: string }): ReportModel {
  const rows: ReportRow[] = [], list = whtAllocations(st, companyId, p.asOf);
  const sums: Record<string, number> = { wht: 0, d0: 0, d31: 0, d61: 0, d90: 0 };
  let month = '';
  for (const a of list) {
    if (a.date.slice(0, 7) !== month) { month = a.date.slice(0, 7); rows.push({ level: 0, kind: 'group', cells: { receipt: monthLabelTh(month) } }); }
    const b = bucket(days(a.date, p.asOf));
    sums.wht += a.wht; sums[b] += a.wht;
    rows.push({ level: 1, kind: 'row', cells: { receipt: a.number, date: a.date, customer: a.customer, cert: a.cert, wht: fromSatang(a.wht), d0: '', d31: '', d61: '', d90: '', [b]: fromSatang(a.wht) }, href: docViewHref('RC', a.rcId)! });
  }
  if (rows.length) rows.push({ level: 0, kind: 'total', cells: { receipt: '', wht: fromSatang(sums.wht), ...Object.fromEntries(BUCKETS.map((k) => [k, sums[k] ? fromSatang(sums[k]) : ''])) } });
  const code = resolveRole(st, 'WhtReceivable', { companyId, docType: 'RC' }).code;
  let gl = 0;
  for (const e of companyEntries(st, companyId)) if (e.date <= p.asOf) for (const l of e.lines) if (l.accountCode === code) gl += toSatang(l.debit) - toSatang(l.credit);
  return {
    kind: 'wht-receivable', titleKey: 'reports.whtRec.title', asOf: p.asOf, params: { asOf: p.asOf },
    columns: [text('receipt'), { key: 'date', labelKey: 'reports.whtRec.date', kind: 'date' }, text('customer'), text('cert'), money('wht'), money('d0'), money('d31'), money('d61'), money('d90')],
    rows, tieOuts: [{ labelKey: 'reports.whtRec.tie', left: fromSatang(sums.wht), right: fromSatang(gl), diff: fromSatang(sums.wht - gl) }],
  };
}
