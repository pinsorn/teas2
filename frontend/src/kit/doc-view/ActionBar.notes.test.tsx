import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { taxInvoice } from '@/descriptors/tax-invoice';
import type { Doc } from '@/domain/types';
import { ActionBar } from './ActionBar';

const ti = (priceIncludesVat: boolean): Doc => ({
  id: 'd1', type: 'TI', number: 'TI-202610-0001', status: 'issued', correctionClass: 'T', revision: 0, version: 2, header: { documentDate: '2026-10-14', partyId: 'pc-01', ...(priceIncludesVat ? { priceIncludesVat } : {}) },
  lines: [], totals: { gross: '0.00', discount: '0.00', net: '0.00', vat: '0.00', total: '1000.00', amountInWords: '' }, locks: [], createdBy: { kind: 'user', id: 'u', name: 'u' }, outstanding: '1000.00',
});
const bar = (d: Doc) => render(<ActionBar descriptor={taxInvoice} doc={d} permissions={['doc.TI.read', 'doc.TI.create', 'doc.CN.create', 'doc.DN.create']} vatRegistered onCancel={vi.fn()} />);

describe('ActionBar: ออกใบลดหนี้ / ออกใบเพิ่มหนี้', () => {
  it('a VAT-exclusive TI links both to the note editor with ?adjust=<id>', () => {
    bar(ti(false));
    expect(screen.getByRole('link', { name: 'ออกใบลดหนี้' })).toHaveAttribute('href', '/sales/credit-notes/new?adjust=d1');
    expect(screen.getByRole('link', { name: 'ออกใบเพิ่มหนี้' })).toHaveAttribute('href', '/sales/debit-notes/new?adjust=d1');
  });
  it('M3: on a VAT-inclusive TI both stay, disabled, and say why (a correction plan is the way)', () => {
    bar(ti(true));
    expect(screen.queryByRole('link', { name: 'ออกใบลดหนี้' })).toBeNull();
    expect(screen.getByRole('button', { name: 'ออกใบลดหนี้' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'ออกใบเพิ่มหนี้' })).toBeDisabled();
    expect(screen.getAllByText(/ราคารวมภาษี.*แก้ไข/).length).toBeGreaterThan(0);
  });
});
