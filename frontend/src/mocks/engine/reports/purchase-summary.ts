import type { ReportModel } from '@/domain/reports';
import type { MockState } from '../../store';
import { summaryReport } from './sales-summary';

/** ReportModel `purchase-summary`: the vendor mirror of the sales summary from PB / PDN (positive) and PCN (negative), dated by document date; its claimed-VAT column is tied to the input VAT register (claim period, recoverable VAT only). */
export const purchaseSummary = (st: MockState, companyId: string, p: Record<string, string>): ReportModel => summaryReport('purchases', st, companyId, p);
