'use client';
import type { PaperModel } from '@/domain/types';
import { TaxInvoicePaper } from './TaxInvoicePaper';

/** EX: the same A4 sheet and pagination as the other documents. The employee is the party ("ผู้เบิก"), each line says which vendor tax invoice stands behind its VAT, and the approval is on the signature line. */
export function ExpenseClaimPaper({ model, measure }: { model: PaperModel; /** Tests only: row height, in place of real layout. */ measure?: (rowIndex: number) => number }) {
  return <TaxInvoicePaper model={model} measure={measure} />;
}
