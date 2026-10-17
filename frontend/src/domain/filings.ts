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
export interface TaxPaymentLines { due: Money; lines: (BankLine & { accountName: string })[] }
/** One finalized filing in the history list. `net` = box 11 (the tax to pay, or the excess). */
export interface FilingHistoryItem { form: FilingForm; period: string; finalizedAt: string; finalizedBy: string; net: Money; overpaid: boolean; payment?: TaxPaymentState['status']; paidOn?: IsoDate }

/** TX3a: the year data of the corporate income tax (ภ.ง.ด.50 / 51): what the books cannot say. Signed adjustments are per ภ.ง.ด.50 line 10 / 11 (added to the profit) and 13 (deducted); prior-year losses are listed by the year they arose. */
export interface CitAdjustment { id: string; line: 10 | 11 | 13; amount: Money; reason: string; at: string; by: string }
export interface CitLoss { year: number; amount: Money }
/** The ภ.ง.ด.51 path: the profit estimate typed in, or the actual profit of months 1-6 times two. */
export interface CitEstimate { mode: 'input' | 'h1x2'; netProfit?: Money }
export interface CitYearData { year: number; paidUpCapital: Money; losses: CitLoss[]; adjustments: CitAdjustment[]; estimate?: CitEstimate }
/** The year data with what the books say beside it; `pnd50Filed` freezes everything, `pnd51Filed` the estimate and the capital. */
export interface CitYearView extends CitYearData { exists: boolean; revenue: Money; netProfit: Money; sme: boolean; yearClosed: boolean; pnd50Filed: boolean; pnd51Filed: boolean }
export interface CitYearPatch { paidUpCapital?: Money; losses?: CitLoss[]; estimate?: CitEstimate | null }
