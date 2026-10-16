import type { CorrectionClass, DocStatus, DocType, MarkKey } from './types';

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
/** A document that carries an outstanding balance: the types flagged above, and the frozen open items of an opening-balance batch (type OB with `obSide`; the batch itself carries none). */
export const carriesBalance = (d: { type: DocType; header: { obSide?: string } }): boolean => DOC_TYPES[d.type].outstanding || (d.type === 'OB' && !!d.header.obSide);
export const CLASS = Object.fromEntries(Object.entries(DOC_TYPES).map(([t, i]) => [t, i.class])) as Record<DocType, CorrectionClass>;
export const isTypeAvailable = (t: DocType, vatRegistered: boolean) =>
  DOC_TYPES[t].vat === 'both' || (DOC_TYPES[t].vat === 'vat-only') === vatRegistered;
/** SP0 §7.7 (no RC: receipts are built from open items - settlement allocations - never by conversion). The engine refuses any pair not listed; a type's task enables its row's UI. */
export const CONVERSIONS: Partial<Record<DocType, DocType[]>> = {
  QT: ['SO', 'TI', 'IV'], SO: ['DO', 'TI', 'IV'], DO: ['TI', 'IV'], TI: ['BL', 'CN', 'DN'], IV: ['BL'],
  PO: ['PB', 'PV'], PB: ['PV'], EX: ['PV'],
};

/** D-12 / D-17: the open-item types a document allocates to (RC settles TI / IV; PV settles PB and EX only). The engine refuses any other target. */
export const SETTLES: Partial<Record<DocType, DocType[]>> = { RC: ['TI', 'IV', 'OB'], PV: ['PB', 'EX', 'OB'] };

/** SP0 7.8 Groups: the open-item types a billing statement lists (BL groups TI / IV). No ledger, no balance effect; the amounts are informational. */
export const GROUPS: Partial<Record<DocType, DocType[]>> = { BL: ['TI', 'IV'] };

/** Marks a document type can carry (SP1c S1). Only on a live document; a QT's rejection needs a reason. */
export const MARKS: Partial<Record<DocType, MarkKey[]>> = { QT: ['accepted', 'rejected'], DO: ['delivered'], PO: ['sent'] };

/** The conversion targets a user may actually use: offered by the type, available to the company, and creatable by the role (one filter for the action bar and the dialog). */
export const convertTargets = (offered: DocType[] | undefined, vatRegistered: boolean, permissions: string[]): DocType[] =>
  (offered ?? []).filter((x) => isTypeAvailable(x, vatRegistered) && permissions.includes(`doc.${x}.create`));

/** Types whose unconverted remainder can be closed (a mark, SP1c S2): the N-class documents that are converted onward line by line. */
export const CLOSEABLE: DocType[] = ['SO', 'DO', 'PO'];

/** CN / DN reason codes `[SP-R]` (reference data, wording awaits SP-R): the codes a note of each type accepts. The Thai wording the paper prints is `mocks/fixtures/reason-codes.ts`. */
export const REASON_CODES: Partial<Record<DocType, string[]>> = {
  CN: ['RETURN', 'PRICE_REDUCTION', 'DISCOUNT', 'SERVICE_SHORT', 'OTHER'],
  DN: ['PRICE_INCREASE', 'QTY_EXCESS', 'OTHER'],
  PCN: ['RETURN', 'PRICE_REDUCTION', 'DISCOUNT', 'SERVICE_SHORT', 'OTHER'],
  PDN: ['PRICE_INCREASE', 'QTY_EXCESS', 'OTHER'],
};

/** Adjustment notes and the document each one adjusts (ADR-0002 analogue for purchases): CN / DN -> the tax invoice we issued, PCN / PDN -> the purchase bill we recorded. */
export const ADJUSTS: Partial<Record<DocType, DocType>> = { CN: 'TI', DN: 'TI', PCN: 'PB', PDN: 'PB' };
/** The decreasing note of each side (the credit): CN lowers a receivable, PCN lowers a payable. */
export const CREDIT_NOTES: DocType[] = ['CN', 'PCN'];
