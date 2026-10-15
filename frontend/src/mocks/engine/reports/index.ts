import type { ReportKind, ReportModel } from '@/domain/reports';
import en from '@/messages/en.json';
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

export type Locale = 'th' | 'en';
const msg = (locale: Locale, key: string) =>
  key.split('.').reduce<unknown>((a, k) => (a as Record<string, unknown> | undefined)?.[k], locale === 'en' ? en : th) as string | undefined ?? key;
const BOM = String.fromCharCode(0xfeff);
/** A cell a spreadsheet would run as a formula (= + - @ tab CR) gets a leading apostrophe; a plain negative number in a money column stays a number. */
const FORMULA = /^[=+\-@\t\r]/;
const NEGATIVE_MONEY = /^-\d+\.\d{2}$/;
const cell = (v: string, money = false) => {
  const safe = FORMULA.test(v) && !(money && NEGATIVE_MONEY.test(v)) ? `'${v}` : v;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
};

/** text/csv body: UTF-8 BOM (Excel reads Thai), CRLF line ends, headers in the caller's locale. Money stays the server's plain decimal string;
 *  a total row is named in the first text column. */
export function reportCsv(m: ReportModel, locale: Locale = 'th'): string {
  const label = m.columns.findIndex((c) => !c.kind || c.kind === 'text');
  const body = m.rows.map((r) => m.columns.map((c, i) => (!r.cells[c.key] && i === label && (r.kind === 'total' || r.kind === 'subtotal')
    ? cell(msg(locale, 'reports.total')) : cell(r.cells[c.key] ?? '', c.kind === 'money'))));
  return `${BOM}${[m.columns.map((c) => cell(msg(locale, c.labelKey))), ...body].map((l) => l.join(',')).join('\r\n')}\r\n`;
}
