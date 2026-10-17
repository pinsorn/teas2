import type { ReportKind, TieOut } from './reports';
import type { IsoDate, Money } from './types';

/** A tax filing as the server states it (SP1c TX1). Every figure is a server model; the frontend lays it out and never sums. */
export type FilingForm = 'PP30' | 'PND1' | 'PND1A' | 'PND2' | 'PND3' | 'PND53' | 'PND54' | 'PP36' | 'PND50' | 'PND51' | 'SSO1-10';
export interface FilingBox { code: string; labelTh: string; amount: Money; source?: { reportKind: ReportKind; params: Record<string, string> } }
export interface FilingBlocker { code: string; labelTh: string; href?: string }
export interface FilingModel {
  form: FilingForm; period: string /* YYYY-MM or YYYY */; status: 'draft' | 'finalized';
  boxes: FilingBox[]; tieOuts: TieOut[]; blockers: FilingBlocker[]; warnings: string[];
  finalizedAt?: string; finalizedBy?: string; /** a finalized filing: the company as it was when filed (M2) */ company?: { taxId: string; branchCode: string; legalNameTh: string }; version: number; dueDate: IsoDate; exports: ('rdprep-txt' | 'pdf')[];
}
/** One finalized filing in the history list. `net` = box 11 (the tax to pay, or the excess). */
export interface FilingHistoryItem { form: FilingForm; period: string; finalizedAt: string; finalizedBy: string; net: Money; overpaid: boolean }
