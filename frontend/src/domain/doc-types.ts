import type { CorrectionClass, DocStatus, DocType } from './types';

/** Statuses of a document that is in force (the one definition: engine, locks, invariants, action bar). */
export const LIVE: DocStatus[] = ['issued', 'partly_settled', 'settled'];
export type VatScope = 'vat-only' | 'non-vat-only' | 'both';
export interface DocTypeInfo { class: CorrectionClass; vat: VatScope; ledger: boolean; outstanding: boolean; printable: boolean }
export const DOC_TYPES: Record<DocType, DocTypeInfo> = {
  QT: { class: 'N', vat: 'both', ledger: false, outstanding: false, printable: true },
  SO: { class: 'N', vat: 'both', ledger: false, outstanding: false, printable: true },
  DO: { class: 'N', vat: 'both', ledger: false, outstanding: false, printable: true },
  BL: { class: 'N', vat: 'both', ledger: false, outstanding: false, printable: true },
  IV: { class: 'L', vat: 'non-vat-only', ledger: true, outstanding: true, printable: true },
  TI: { class: 'T', vat: 'vat-only', ledger: true, outstanding: true, printable: true },
  RC: { class: 'T', vat: 'both', ledger: true, outstanding: false, printable: true },
  CN: { class: 'T', vat: 'vat-only', ledger: true, outstanding: false, printable: true },
  DN: { class: 'T', vat: 'vat-only', ledger: true, outstanding: false, printable: true },
  PO: { class: 'N', vat: 'both', ledger: false, outstanding: false, printable: true },
  PB: { class: 'L', vat: 'both', ledger: true, outstanding: true, printable: false },
  PCN: { class: 'L', vat: 'both', ledger: true, outstanding: false, printable: false },
  PDN: { class: 'L', vat: 'both', ledger: true, outstanding: false, printable: false },
  PV: { class: 'L', vat: 'both', ledger: true, outstanding: false, printable: true },
  WT: { class: 'T', vat: 'both', ledger: false, outstanding: false, printable: true },
  EX: { class: 'L', vat: 'both', ledger: true, outstanding: true, printable: true },
  JV: { class: 'L', vat: 'both', ledger: true, outstanding: false, printable: true },
  FA: { class: 'L', vat: 'both', ledger: true, outstanding: false, printable: false },
  DP: { class: 'L', vat: 'both', ledger: true, outstanding: false, printable: false },
  PR: { class: 'L', vat: 'both', ledger: true, outstanding: false, printable: true },
  OB: { class: 'L', vat: 'both', ledger: true, outstanding: false, printable: false },
};
export const CLASS = Object.fromEntries(Object.entries(DOC_TYPES).map(([t, i]) => [t, i.class])) as Record<DocType, CorrectionClass>;
export const isTypeAvailable = (t: DocType, vatRegistered: boolean) =>
  DOC_TYPES[t].vat === 'both' || (DOC_TYPES[t].vat === 'vat-only') === vatRegistered;
/** SP0 §7.7. The engine refuses any pair not listed; a type's task enables its row's UI. */
export const CONVERSIONS: Partial<Record<DocType, DocType[]>> = {
  QT: ['SO', 'TI', 'IV'], SO: ['DO', 'TI', 'IV'], DO: ['TI', 'IV'], TI: ['BL', 'RC', 'CN', 'DN'], IV: ['BL', 'RC'],
  PO: ['PB', 'PV'], PB: ['PCN', 'PDN', 'PV'], EX: ['PV'],
};

