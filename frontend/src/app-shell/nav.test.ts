import { describe, expect, it } from 'vitest';
import { PERMISSIONS_BY_ROLE } from '@/mocks/permissions';
import { NAV, visibleNav } from './nav';

const labels = (g: ReturnType<typeof visibleNav>) => g.flatMap((x) => x.items.map((i) => i.key));

describe('navigation', () => {
  it('has the ten groups of SP0 §9.1 in order', () => {
    expect(NAV.map((g) => g.key)).toEqual(['home', 'sales', 'purchases', 'finance', 'accounting', 'tax', 'payroll', 'reports', 'master', 'settings']);
  });
  it('hides VAT-only items for a non-VAT company and shows the invoice instead', () => {
    const v = labels(visibleNav(NAV, { permissions: PERMISSIONS_BY_ROLE.accountant, vatRegistered: false }));
    expect(v).not.toContain('taxInvoices');
    expect(v).toContain('invoices');
  });
  it('hides items the role cannot read', () => {
    const v = labels(visibleNav(NAV, { permissions: PERMISSIONS_BY_ROLE.admin, vatRegistered: true }));
    expect(v).not.toContain('taxInvoices');
  });
  it('drops a group with no visible item', () => {
    const g = visibleNav(NAV, { permissions: [], vatRegistered: true }).map((x) => x.key);
    expect(g).toEqual(['home']);
  });
  it('keeps the tax invoice and hides the invoice for a VAT company', () => {
    const v = labels(visibleNav(NAV, { permissions: PERMISSIONS_BY_ROLE.accountant, vatRegistered: true }));
    expect(v).toContain('taxInvoices');
    expect(v).not.toContain('invoices');
  });
  it('item keys and hrefs are unique', () => {
    const items = NAV.flatMap((g) => g.items);
    expect(new Set(items.map((i) => i.key)).size).toBe(items.length);
    expect(new Set(items.map((i) => i.href)).size).toBe(items.length);
  });
});
