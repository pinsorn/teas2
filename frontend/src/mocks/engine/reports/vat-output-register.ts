import type { ReportModel } from '@/domain/reports';
import type { MockState } from '../../store';
import { registerReport } from '../filings/pp30';

/** ทะเบียนภาษีขาย (TX1): every issued TI / CN / DN of the month once, signed, a cancelled TI as ยกเลิก 0.00 (A.9), the sale of a fixed asset as ขายสินทรัพย์ <FA number>; a finalized month reads its snapshot. Tied to GL 2151 (I12). */
export const vatOutputRegister = (st: MockState, companyId: string, p: Record<string, string>): ReportModel => registerReport('vat-output-register', st, companyId, p);
