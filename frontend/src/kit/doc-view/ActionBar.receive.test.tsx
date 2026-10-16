import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { billingStatement } from '@/descriptors/billing-statement';
import { invoice } from '@/descriptors/invoice';
import { taxInvoice } from '@/descriptors/tax-invoice';
import type { Doc, DocStatus } from '@/domain/types';
import { ActionBar } from './ActionBar';

const doc = (type: Doc['type'], status: DocStatus, outstanding?: string): Doc => ({
  id: 'd1', type, number: `${type}-202610-0001`, status, correctionClass: 'T', revision: 0, version: 2, header: { documentDate: '2026-10-14', partyId: 'pc-01' },
  lines: [], totals: { gross: '0.00', discount: '0.00', net: '0.00', vat: '0.00', total: '1000.00', amountInWords: '' }, locks: [], createdBy: { kind: 'user', id: 'u', name: 'u' },
  ...(outstanding ? { outstanding } : {}),
});
const bar = (d: typeof taxInvoice, document: Doc, permissions: string[]) =>
  render(<ActionBar descriptor={d} doc={document} permissions={permissions} vatRegistered={d.type !== 'IV'} onCancel={vi.fn()} />);
const can = ['doc.TI.read', 'doc.TI.create', 'doc.IV.read', 'doc.IV.create', 'doc.BL.read', 'doc.BL.create', 'doc.RC.create'];

describe('ActionBar: รับชำระ (receive payment)', () => {
  it('a TI with something outstanding links to the receipt editor with ?settle=<id>', () => {
    bar(taxInvoice, doc('TI', 'partly_settled', '400.00'), can);
    expect(screen.getByRole('link', { name: 'รับชำระ' })).toHaveAttribute('href', '/sales/receipts/new?settle=d1');
  });
  it('an IV likewise, and a BL keeps ?fromBl=<id>', () => {
    const iv = bar(invoice, doc('IV', 'issued', '1000.00'), can);
    expect(screen.getByRole('link', { name: 'รับชำระ' })).toHaveAttribute('href', '/sales/receipts/new?settle=d1');
    iv.unmount();
    bar(billingStatement, doc('BL', 'issued'), can);
    expect(screen.getByRole('link', { name: 'รับชำระ' })).toHaveAttribute('href', '/sales/receipts/new?fromBl=d1');
  });
  it('nothing to receive: a draft, a cancelled, a replaced and a fully settled invoice have no button', () => {
    for (const d of [doc('TI', 'draft'), doc('TI', 'cancelled'), doc('TI', 'replaced'), doc('TI', 'settled', '0.00'), doc('TI', 'issued', '0.00')]) {
      const r = bar(taxInvoice, d, can);
      expect(screen.queryByRole('link', { name: 'รับชำระ' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'รับชำระ' })).toBeNull();
      r.unmount();
    }
  });
  it('without the right to create a receipt the button stays, disabled, and says which permission is missing', () => {
    bar(taxInvoice, doc('TI', 'issued', '1000.00'), can.filter((p) => p !== 'doc.RC.create'));
    expect(screen.queryByRole('link', { name: 'รับชำระ' })).toBeNull();
    expect(screen.getByRole('button', { name: 'รับชำระ' })).toBeDisabled();
    expect(screen.getByText(/doc\.RC\.create/)).toBeInTheDocument();
  });
});
