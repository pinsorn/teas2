'use client';
import { useParams } from 'next/navigation';
import { taxInvoice } from '@/descriptors/tax-invoice';
import { DocView } from '@/kit/doc-view/DocView';
import { VatGate } from '../gate';

export default function TaxInvoiceViewPage() {
  const { id } = useParams<{ id: string }>();
  return <VatGate><DocView descriptor={taxInvoice} id={id} /></VatGate>;
}
