import type { ReportKind, TieOut } from './reports';
import type { BankLine, IsoDate, Money } from './types';

/** A tax filing as the server states it (SP1c TX1). Every figure is a server model; the frontend lays it out and never sums. */
export type FilingForm = 'PP30' | 'PND1' | 'PND1A' | 'PND2' | 'PND3' | 'PND53' | 'PND54' | 'PP36' | 'PND50' | 'PND51' | 'SSO1-10';
export interface FilingBox { code: string; labelTh: string; amount: Money; /** TX2: a number of payees, not baht */ kind?: 'count'; source?: { reportKind: ReportKind; params: Record<string, string> } }
export interface FilingBlocker { code: string; labelTh: string; href?: string }
export interface FilingModel {
  form: FilingForm; period: string /* YYYY-MM or YYYY */; status: 'draft' | 'finalized';
  boxes: FilingBox[]; tieOuts: TieOut[]; blockers: FilingBlocker[]; warnings: string[];
  /** TX2: the attachment of a ภ.ง.ด. (one row per certificate) or the vouchers behind a ภ.พ.36; a finalized one is the frozen snapshot */ attachment?: { columns: { key: string; labelTh: string }[]; rows: Record<string, string>[] };
  finalizedAt?: string; finalizedBy?: string; /** a finalized filing: the company as it was when filed (M2) */ company?: { taxId: string; branchCode: string; legalNameTh: string }; version: number; dueDate: IsoDate; exports: ('rdprep-txt' | 'pdf')[];
  /** TX2c: a finalized filing's payment to the Revenue Department (derived from the in-force payment journal) */ payment?: TaxPaymentState;
}
/** TX2c: `due` = the tax the return asks to be paid; `extras` = the other debit legs (fee, เงินเพิ่ม) of the live payment, omitted when 0. */
export interface TaxPaymentState { due: Money; status: 'unpaid' | 'paid' | 'nothing_due'; paidOn?: IsoDate; journalId?: string; lineId?: string; accountId?: string; extras?: Money }
/** TX2c: the statement lines a return can be paid from (money out, after the period, at least the tax; the exact ones first). */
export interface TaxPaymentLines { due: Money; lines: BankLine[] }
/** One finalized filing in the history list. `net` = box 11 (the tax to pay, or the excess). */
export interface FilingHistoryItem { form: FilingForm; period: string; finalizedAt: string; finalizedBy: string; net: Money; overpaid: boolean; payment?: TaxPaymentState['status']; paidOn?: IsoDate }
