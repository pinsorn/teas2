import { docListHref } from '@/descriptors';
import { describe, expect, it } from 'vitest';
import { PERMISSIONS_BY_ROLE } from '@/mocks/permissions';
import { NAV, matchNavItem, visibleNav } from './nav';

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

describe('docListHref / matchNavItem', () => {
  it('routes a document type to its list, honouring VAT status', () => {
    expect(docListHref('TI', true)).toBe('/sales/tax-invoices');
    expect(docListHref('TI', false)).toBeUndefined();
    expect(docListHref('IV', false)).toBeUndefined();
    expect(docListHref('IV', true)).toBeUndefined();
    expect(docListHref('QT', true)).toBe('/sales/quotations');
    expect(docListHref('QT', false)).toBe('/sales/quotations'); // QT is for both kinds of company
    expect(docListHref('BL', true)).toBeUndefined(); // not built yet
  });
  it('has no route (so no link) for types without a nav page', () => {
    for (const t of ['JV', 'DP', 'WT', 'FA', 'PR', 'OB'] as const) expect(docListHref(t, true)).toBeUndefined();
  });
  it('matches the longest list route, and only on a segment boundary', () => {
    expect(matchNavItem('/sales/tax-invoices/abc')?.item.key).toBe('taxInvoices');
    expect(matchNavItem('/sales/tax-invoicesX')).toBeUndefined();
    expect(matchNavItem('/')?.item.key).toBe('home');
    expect(matchNavItem('/nope')).toBeUndefined();
  });
});
