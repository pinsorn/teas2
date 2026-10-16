'use client';
import type { PaperModel } from '@/domain/types';
import { TaxInvoicePaper } from './TaxInvoicePaper';

/** RC: the same A4 sheet and pagination as the tax invoice, with the settled documents (number, date, amount, WHT) as rows - or a non-VAT cash bill's own lines - and the server's received / withheld / total figures. */
export function ReceiptPaper({ model, measure }: { model: PaperModel; /** Tests only: row height, in place of real layout. */ measure?: (rowIndex: number) => number }) {
  return <TaxInvoicePaper model={model} measure={measure} receipt />;
}
