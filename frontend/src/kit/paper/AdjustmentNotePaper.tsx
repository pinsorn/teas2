'use client';
import type { PaperModel } from '@/domain/types';
import { TaxInvoicePaper } from './TaxInvoicePaper';

/** CN / DN (ม.86/10): the same A4 sheet and pagination as the tax invoice, plus the block that names the invoice adjusted, the reason and the original / correct / difference values - all the server's. */
export function AdjustmentNotePaper({ model, measure }: { model: PaperModel; /** Tests only: row height, in place of real layout. */ measure?: (rowIndex: number) => number }) {
  return <TaxInvoicePaper model={model} measure={measure} />;
}
