import type { ReportChip, ReportKind, ReportModel } from '@/domain/reports';
import en from '@/messages/en.json';
import th from '@/messages/th.json';
import type { MockState } from '../../store';
import { today } from '../log';
import { generalJournal } from '../journal';
import { apAging } from './ap-aging';
import { arAging } from './ar-aging';
import { assetRegister } from './asset-register';
import { auditLog, reopenHistory } from './audit-log';
import { balanceSheet } from './balance-sheet';
import { bankReconciliation } from './bank-reconciliation';
import { customerStatement } from './customer-statement';
import { generalLedger } from './general-ledger';
import { missingWhtCert } from './missing-wht-cert';
import { numberGaps } from './number-gaps';
import { outstandingPo } from './outstanding-po';
import { profitLoss } from './profit-loss';
import { purchaseSummary } from './purchase-summary';
import { salesSummary } from './sales-summary';
import { taxSummary } from './tax-summary';
import { trialBalance } from './trial-balance';
import { vendorLedger } from './vendor-ledger';
import { vatInputRegister } from './vat-input-register';
import { vatOutputRegister } from './vat-output-register';
import { whtReceivable } from './wht-receivable';

/** The screen's selects send a word for "no comparative" / "by class" (a select cannot be blank-labelled); the engine's own value for both is empty. */
const plain = (v?: string) => (v === 'none' || v === 'class' ? '' : v);
/** Report kinds the mock engine can compute so far (the rest answer 404 report.not_built until their RP task). */
const BUILDERS: Partial<Record<ReportKind, (st: MockState, companyId: string, p: Record<string, string>, perms: string[]) => ReportModel>> = {
  'trial-balance': (st, c, p) => trialBalance(st, c, { ...p, asOf: p.asOf || today() }),
  'profit-loss': (st, c, p) => profitLoss(st, c, { ...p, compare: plain(p.compare), format: plain(p.format), from: p.from || `${today().slice(0, 4)}-01-01`, to: p.to || today() }),
  'balance-sheet': (st, c, p) => balanceSheet(st, c, { ...p, compare: plain(p.compare), format: plain(p.format), asOf: p.asOf || today() }),
  'general-ledger': (st, c, p) => generalLedger(st, c, p),
  'ar-aging': arAging, 'ap-aging': apAging, 'customer-statement': customerStatement, 'vendor-ledger': vendorLedger,
  'sales-summary': salesSummary, 'purchase-summary': purchaseSummary, 'outstanding-po': (st, c, p) => outstandingPo(st, c, { ...p, asOf: p.asOf || today() }),
  'general-journal': (st, c, p) => generalJournal(st, c, { from: p.from, to: p.to, account: p.account?.trim(), source: p.source }),
  'asset-register': (st, c, p) => assetRegister(st, c, { ...p, asOf: p.asOf || today() }),
  'bank-reconciliation': (st, c, p) => bankReconciliation(st, c, { account: p.account ?? '', to: p.to || today() }),
  'wht-receivable': (st, c, p) => whtReceivable(st, c, { asOf: p.asOf || today() }),
  'missing-wht-cert': (st, c) => missingWhtCert(st, c),
  'tax-summary': (st, c, p, perms) => taxSummary(st, c, p, perms.includes('tax.filing.preview')), // an unfiled month is the filing's preview, with the same right
  'number-gaps': (st, c, p) => numberGaps(st, c, p), 'audit-log': (st, c, p) => auditLog(st, c, p), 'reopen-history': (st, c, p) => reopenHistory(st, c, p),
  'vat-output-register': vatOutputRegister,
  'vat-input-register': vatInputRegister,
};
/** M8: a VAT register of a month not yet filed is the filing's preview, with the same right (`tax.filing.preview`). The right the request lacks, or undefined. The reports endpoint and Home's VAT tile share it. */
export const vatRegisterRight = (st: MockState, companyId: string, kind: string, perms: string[], period?: string): string | undefined =>
  kind.startsWith('vat-') && !perms.includes('tax.filing.preview') && !st.filings.some((f) => f.companyId === companyId && f.form === 'PP30' && f.period === period) ? 'tax.filing.preview' : undefined;
export const isBuilt = (k: string): k is ReportKind => Object.hasOwn(BUILDERS, k);
export const buildReport = (st: MockState, companyId: string, kind: ReportKind, p: Record<string, string>, perms: string[] = []) => BUILDERS[kind]!(st, companyId, p, perms);

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

/** A row's status chips as words: "ภ.พ.30 ยื่นแล้ว; ภ.ง.ด.3 ค้างยื่น". */
const statusText = (chips: ReportChip[] = [], locale: Locale) => chips.map((c) => `${c.form} ${msg(locale, `reports.taxSummary.states.${c.state}`)}`.trim()).join('; ');

/** text/csv body: UTF-8 BOM (Excel reads Thai), CRLF line ends, headers in the caller's locale. Money stays the server's plain decimal string;
 *  a total row is named in the first text column. */
export function reportCsv(m: ReportModel, locale: Locale = 'th'): string {
  const label = m.columns.findIndex((c) => !c.kind || c.kind === 'text');
  const body = m.rows.map((r) => m.columns.map((c, i) => (!r.cells[c.key] && i === label && (r.kind === 'total' || r.kind === 'subtotal')
    ? cell(msg(locale, 'reports.total')) : cell(c.kind === 'status' ? statusText(r.chips, locale) : r.cells[c.key] ?? '', c.kind === 'money'))));
  return `${BOM}${[m.columns.map((c) => cell(c.label ?? msg(locale, c.labelKey))), ...body].map((l) => l.join(',')).join('\r\n')}\r\n`;
}
