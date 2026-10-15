import type { IsoDate, Money } from './types';

/** A report is a server-computed model (D-28): the frontend lays it out and never sums. */
export type ReportKind = 'trial-balance' | 'profit-loss' | 'balance-sheet' | 'general-ledger' | 'ar-aging' | 'ap-aging'
  | 'customer-statement' | 'vendor-ledger' | 'sales-summary' | 'purchase-summary' | 'outstanding-po' | 'vat-output-register'
  | 'vat-input-register' | 'wht-receivable' | 'missing-wht-cert' | 'number-gaps' | 'audit-log' | 'asset-register'
  | 'bank-reconciliation' | 'tax-summary';
export interface ReportParamSpec { key: string; kind: 'date' | 'month' | 'year' | 'range' | 'party' | 'account' | 'dimension' | 'select' | 'bool';
  labelKey: string; options?: { value: string; labelKey: string }[]; required?: boolean }
export interface ReportColumn { key: string; labelKey: string; align?: 'start' | 'end'; kind?: 'money' | 'date' | 'text' | 'qty' }
export interface ReportRow { level: 0 | 1 | 2; kind: 'group' | 'row' | 'subtotal' | 'total'; cells: Record<string, string>; href?: string }
export interface TieOut { labelKey: string; left: Money; right: Money; diff: Money } // diff computed by the server
export interface ReportModel { kind: ReportKind; titleKey: string; params: Record<string, string>; asOf?: IsoDate;
  columns: ReportColumn[]; rows: ReportRow[]; tieOuts?: TieOut[]; notes?: string[] }
