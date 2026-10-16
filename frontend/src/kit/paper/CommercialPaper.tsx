'use client';
import type { PaperModel } from '@/domain/types';
import { TaxInvoicePaper } from './TaxInvoicePaper';

/** QT SO DO BL IV PO: same A4 sheet and pagination as the tax invoice; the model supplies title, labels, VAT rows (none for a non-VAT company), revision label and signatures. */
export function CommercialPaper({ model, measure }: { model: PaperModel; /** Tests only: row height, in place of real layout. */ measure?: (rowIndex: number) => number }) {
  return <TaxInvoicePaper model={model} measure={measure} />;
}
