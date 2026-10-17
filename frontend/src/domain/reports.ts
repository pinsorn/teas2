import type { IsoDate, Money } from './types';

/** A report is a server-computed model (D-28): the frontend lays it out and never sums. */
export type ReportKind = 'trial-balance' | 'profit-loss' | 'balance-sheet' | 'general-ledger' | 'ar-aging' | 'ap-aging'
  | 'customer-statement' | 'vendor-ledger' | 'sales-summary' | 'purchase-summary' | 'outstanding-po' | 'vat-output-register'
  | 'vat-input-register' | 'wht-receivable' | 'missing-wht-cert' | 'number-gaps' | 'audit-log' | 'asset-register'
  | 'bank-reconciliation' | 'tax-summary' | 'general-journal';
export interface ReportParamSpec { key: string; kind: 'date' | 'month' | 'year' | 'range' | 'party' | 'account' | 'dimension' | 'select' | 'bool';
  labelKey: string; options?: { value: string; labelKey: string }[]; required?: boolean; /** Carried in the query but not shown (the report is scoped by the page that hosts it). */ hidden?: boolean }
export interface ReportColumn { key: string; labelKey: string; align?: 'start' | 'end'; kind?: 'money' | 'date' | 'text' | 'qty' | 'status' }
export interface ReportRow { level: 0 | 1 | 2; kind: 'group' | 'row' | 'subtotal' | 'total'; cells: Record<string, string>; href?: string }
/** diff = left - right + Σ reconciling (computed by the server). A reconciling line is a NAMED amount one side holds on purpose and the other does not yet (TX2: a ภ.พ.36 booked this month, claimed in next month's ภ.พ.30); positive = the ledger side holds it. */
export interface TieOut { labelKey: string; left: Money; right: Money; diff: Money; reconciling?: { labelTh: string; amount: Money }[] }
export interface ReportModel { kind: ReportKind; titleKey: string; params: Record<string, string>; asOf?: IsoDate;
  columns: ReportColumn[]; rows: ReportRow[]; tieOuts?: TieOut[]; notes?: string[] }

/** TX3b G1: a non-VAT company's last 12 months of sales against the registration threshold. `level` warns from 80 %, `danger` from 100 %; `percent` is rounded down to 0.01. */
export interface VatThresholdWatch { revenue: Money; threshold: Money; percent: string; level: 'ok' | 'warning' | 'danger'; messageTh: string; from: IsoDate; to: IsoDate }
/** TX3b: a form of the Revenue Department as the catalogue lists it. `href` opens the page where it is prepared; `printable` = a React rendition of the paper form from the company data (D-21). */
export interface FormCatalogueItem { form: string; nameTh: string; periodKind: 'month' | 'year' | 'half-year' | 'event'; dueRuleTh: string; lastFinalized: string | null; href: string; printable?: boolean }
export interface FilingHistoryRow { form: string; nameTh: string; period: string; finalizedAt: string; finalizedBy: string; exports: ('rdprep-txt' | 'pdf')[]; href: string }
export interface FormCatalogue { forms: FormCatalogueItem[]; history: FilingHistoryRow[]; company: { legalNameTh: string; taxId: string; branchCode: string; address: string } }
