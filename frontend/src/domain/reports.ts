import type { IsoDate, Money } from './types';

/** A report is a server-computed model (D-28): the frontend lays it out and never sums. */
export type ReportKind = 'trial-balance' | 'profit-loss' | 'balance-sheet' | 'general-ledger' | 'ar-aging' | 'ap-aging'
  | 'customer-statement' | 'vendor-ledger' | 'sales-summary' | 'purchase-summary' | 'outstanding-po' | 'vat-output-register'
  | 'vat-input-register' | 'wht-receivable' | 'missing-wht-cert' | 'number-gaps' | 'audit-log' | 'asset-register'
  | 'bank-reconciliation' | 'tax-summary' | 'general-journal';
export interface ReportParamSpec { key: string; kind: 'date' | 'month' | 'year' | 'range' | 'party' | 'account' | 'dimension' | 'select' | 'bool';
  labelKey: string; options?: { value: string; labelKey: string }[]; required?: boolean; /** Carried in the query but not shown (the report is scoped by the page that hosts it). */ hidden?: boolean }
export interface ReportColumn { key: string; labelKey: string; align?: 'start' | 'end'; kind?: 'money' | 'date' | 'text' | 'qty' }
export interface ReportRow { level: 0 | 1 | 2; kind: 'group' | 'row' | 'subtotal' | 'total'; cells: Record<string, string>; href?: string }
/** diff = left - right + Σ reconciling (computed by the server). A reconciling line is a NAMED amount one side holds on purpose and the other does not yet (TX2: a ภ.พ.36 booked this month, claimed in next month's ภ.พ.30); positive = the ledger side holds it. */
export interface TieOut { labelKey: string; left: Money; right: Money; diff: Money; reconciling?: { labelTh: string; amount: Money }[] }
export interface ReportModel { kind: ReportKind; titleKey: string; params: Record<string, string>; asOf?: IsoDate;
  columns: ReportColumn[]; rows: ReportRow[]; tieOuts?: TieOut[]; notes?: string[] }
