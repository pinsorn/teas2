import type { ComponentType } from 'react';
import type { DocType, PaperModel } from '@/domain/types';
import { AdjustmentNotePaper } from './AdjustmentNotePaper';
import { CommercialPaper } from './CommercialPaper';
import { ReceiptPaper } from './ReceiptPaper';
import { TaxInvoicePaper } from './TaxInvoicePaper';

export const PAPERS: Partial<Record<DocType, ComponentType<{ model: PaperModel }>>> = { TI: TaxInvoicePaper, QT: CommercialPaper, SO: CommercialPaper, DO: CommercialPaper, IV: CommercialPaper, BL: CommercialPaper, RC: ReceiptPaper, CN: AdjustmentNotePaper, DN: AdjustmentNotePaper, PO: CommercialPaper };
