import type { ComponentType } from 'react';
import type { DocType, PaperModel } from '@/domain/types';
import { AdjustmentNotePaper } from './AdjustmentNotePaper';
import { CommercialPaper } from './CommercialPaper';
import { ExpenseClaimPaper } from './ExpenseClaimPaper';
import { JournalVoucherPaper } from './JournalVoucherPaper';
import { PaymentVoucherPaper } from './PaymentVoucherPaper';
import { PayslipPrint } from './PayslipPaper';
import { ReceiptPaper } from './ReceiptPaper';
import { TaxInvoicePaper } from './TaxInvoicePaper';
import { WhtCertificatePaper } from './WhtCertificatePaper';

export const PAPERS: Partial<Record<DocType, ComponentType<{ model: PaperModel }>>> = { TI: TaxInvoicePaper, QT: CommercialPaper, SO: CommercialPaper, DO: CommercialPaper, IV: CommercialPaper, BL: CommercialPaper, RC: ReceiptPaper, CN: AdjustmentNotePaper, DN: AdjustmentNotePaper, PO: CommercialPaper, PV: PaymentVoucherPaper, EX: ExpenseClaimPaper, JV: JournalVoucherPaper, WT: WhtCertificatePaper, PR: PayslipPrint };
