import type { ReportModel } from '@/domain/reports';
import type { MockState } from '../../store';
import { partyStatement } from './customer-statement';

/** ReportModel `vendor-ledger`: the payable mirror of the customer statement (ledger 2110, credit-positive). */
export const vendorLedger = (st: MockState, companyId: string, p: Record<string, string>): ReportModel => partyStatement('AP', st, companyId, p);
