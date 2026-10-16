import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { purchaseBill } from '@/descriptors/purchase-bill';
import type { Doc } from '@/domain/types';
import { ActionBar } from './ActionBar';

const pb = (extra: Partial<Doc> = {}): Doc => ({
  id: 'b1', type: 'PB', number: 'PB-202610-0001', status: 'issued', correctionClass: 'L', revision: 0, version: 2, header: { documentDate: '2026-10-14', partyId: 'pv-01' },
  lines: [], totals: { gross: '0.00', discount: '0.00', net: '0.00', vat: '0.00', total: '1000.00', amountInWords: '' }, locks: [], createdBy: { kind: 'user', id: 'u', name: 'u' }, outstanding: '1000.00', ...extra,
});
const bar = (d: Doc, permissions: string[], vatRegistered = true) => render(<ActionBar descriptor={purchaseBill} doc={d} permissions={permissions} vatRegistered={vatRegistered} onCancel={vi.fn()} />);

describe('ActionBar: บันทึกใบลดหนี้ / ใบเพิ่มหนี้จากผู้ขาย on a purchase bill', () => {
  it('links both notes to their editors on ?adjust=<bill> for a role that may create them, in a company of either VAT status', () => {
    bar(pb(), ['doc.PB.read', 'doc.PB.create', 'doc.PCN.create', 'doc.PDN.create'], false);
    expect(screen.getByRole('link', { name: 'บันทึกใบลดหนี้จากผู้ขาย' })).toHaveAttribute('href', '/purchases/vendor-notes/new?adjust=b1');
    expect(screen.getByRole('link', { name: 'บันทึกใบเพิ่มหนี้จากผู้ขาย' })).toHaveAttribute('href', '/purchases/vendor-debit-notes/new?adjust=b1');
    expect(screen.queryByText('ออกใบลดหนี้')).toBeNull(); // the sales notes belong to a tax invoice
    expect(screen.queryByText('ออกใบเพิ่มหนี้')).toBeNull();
  });
  it('a role without the create permission sees them disabled with the permission named', () => {
    bar(pb(), ['doc.PB.read', 'doc.PB.create']);
    expect(screen.getByRole('button', { name: 'บันทึกใบลดหนี้จากผู้ขาย' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'บันทึกใบเพิ่มหนี้จากผู้ขาย' })).toHaveAccessibleDescription(/doc\.PDN\.create/);
  });
  it('a bill has no print action (a vendor\'s document is recorded, not printed) but keeps edit and copy', () => {
    bar(pb(), ['doc.PB.read', 'doc.PB.create']);
    expect(screen.queryByText('พิมพ์')).toBeNull();
    expect(screen.getByRole('link', { name: 'แก้ไข' })).toHaveAttribute('href', '/purchases/bills/b1/edit');
  });
  it('a cancelled bill adjusts nothing, and a bill has no generic "convert to…"', () => {
    bar(pb({ status: 'cancelled' }), ['doc.PCN.create', 'doc.PDN.create']);
    expect(screen.queryByText('บันทึกใบลดหนี้จากผู้ขาย')).toBeNull();
    expect(screen.queryByRole('button', { name: 'แปลงเป็น…' })).toBeNull();
  });
});
