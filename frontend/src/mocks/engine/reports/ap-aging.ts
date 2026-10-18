import type { ReportModel } from '@/domain/reports';
import type { MockState } from '../../store';
import { agingReport } from './ar-aging';

/** ReportModel `ap-aging`: the payable mirror of the AR aging (PB, opening-balance AP items, prepayments; ledger 2110 / 1140). */
export const apAging = (st: MockState, companyId: string, p: Record<string, string>): ReportModel => agingReport('AP', st, companyId, p);
