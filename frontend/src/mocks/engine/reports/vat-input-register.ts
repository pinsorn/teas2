import type { ReportModel } from '@/domain/reports';
import type { MockState } from '../../store';
import { registerReport } from '../filings/pp30';

/** ทะเบียนภาษีซื้อ (TX1): the vendor documents filed in the month by CLAIM period (not the document month), recoverable VAT only; a vendor credit note gives it back. A finalized month reads its snapshot. Tied to GL 1170 (I12). */
export const vatInputRegister = (st: MockState, companyId: string, p: Record<string, string>): ReportModel => registerReport('vat-input-register', st, companyId, p);
