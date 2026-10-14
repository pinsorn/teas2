import type { ReportKind, ReportModel } from '@/domain/reports';
import th from '@/messages/th.json';
import type { MockState } from '../../store';
import { today } from '../log';
import { trialBalance } from './trial-balance';

/** Report kinds the mock engine can compute so far (the rest answer 404 report.not_built until their RP task). */
const BUILDERS: Partial<Record<ReportKind, (st: MockState, companyId: string, p: Record<string, string>) => ReportModel>> = {
  'trial-balance': (st, c, p) => trialBalance(st, c, { ...p, asOf: p.asOf || today() }),
};
export const isBuilt = (k: string): k is ReportKind => Object.hasOwn(BUILDERS, k);
export const buildReport = (st: MockState, companyId: string, kind: ReportKind, p: Record<string, string>) => BUILDERS[kind]!(st, companyId, p);

const msg = (key: string) => key.split('.').reduce<unknown>((a, k) => (a as Record<string, unknown> | undefined)?.[k], th) as string | undefined ?? key;
const BOM = String.fromCharCode(0xfeff);
const cell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);

/** text/csv body: UTF-8 BOM (Excel reads Thai), CRLF line ends. Money stays the server's plain decimal string; a total row is named in the first text column. */
export function reportCsv(m: ReportModel): string {
  const label = m.columns.findIndex((c) => !c.kind || c.kind === 'text');
  const body = m.rows.map((r) => m.columns.map((c, i) => cell(!r.cells[c.key] && i === label && (r.kind === 'total' || r.kind === 'subtotal') ? msg('reports.total') : r.cells[c.key] ?? '')));
  return `${BOM}${[m.columns.map((c) => cell(msg(c.labelKey))), ...body].map((l) => l.join(',')).join('\r\n')}\r\n`;
}
