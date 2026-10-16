'use client';
import type { PaperModel } from '@/domain/types';
import { TaxInvoicePaper } from './TaxInvoicePaper';

/** PV: the same A4 sheet and pagination as the receipt, reworded for money paid out - the bills settled and the voucher's own lines as rows, the tax withheld per WHT type, the payment method / bank / cheque,
 *  the server's cash paid / withheld / total, and the four voucher signatures. A voucher is an internal record, not a tax document. */
export function PaymentVoucherPaper({ model, measure }: { model: PaperModel; /** Tests only: row height, in place of real layout. */ measure?: (rowIndex: number) => number }) {
  return <TaxInvoicePaper model={model} measure={measure} receipt voucher />;
}
