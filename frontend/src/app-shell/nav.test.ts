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
    expect(g).toEqual(['home', 'settings']); // HC2a: the settings group keeps TEAS Connect (every member's own keys)
    expect(visibleNav(NAV, { permissions: [], vatRegistered: true }).find((x) => x.key === 'settings')?.items.map((i) => i.key)).toEqual(['settingsConnect']);
  });
  it('keeps the tax invoice and hides the invoice for a VAT company', () => {
    const v = labels(visibleNav(NAV, { permissions: PERMISSIONS_BY_ROLE.accountant, vatRegistered: true }));
    expect(v).toContain('taxInvoices');
    expect(v).not.toContain('invoices');
  });
  it('settings: company needs settings.manage, users and roles need users.manage (ST1)', () => {
    const need = (k: string) => NAV.flatMap((g) => g.items).find((i) => i.key === k)?.permission;
    expect([need('settingsCompany'), need('settingsUsers'), need('settingsRoles')]).toEqual(['settings.manage', 'users.manage', 'users.manage']);
    const v = labels(visibleNav(NAV, { permissions: ['settings.manage'], vatRegistered: true }));
    expect(v).toContain('settingsCompany');
    expect(v).not.toContain('settingsRoles');
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
    expect(docListHref('IV', false)).toBe('/sales/invoices');
    expect(docListHref('IV', true)).toBeUndefined(); // a VAT company issues tax invoices instead
    expect(docListHref('QT', true)).toBe('/sales/quotations');
    expect(docListHref('QT', false)).toBe('/sales/quotations'); // QT is for both kinds of company
    expect(docListHref('BL', true)).toBe('/sales/billing-statements');
  });
  it('has no route (so no link) for types without a nav page', () => {
    expect(docListHref('PR', true)).toBe('/payroll/runs'); // PY1
    expect(docListHref('FA', true)).toBe('/accounting/fixed-assets'); // AC5
    expect(docListHref('DP', false)).toBe('/accounting/depreciation-runs');
    expect(docListHref('JV', true)).toBe('/accounting/journal-vouchers'); // AC1
    expect(docListHref('WT', true)).toBe('/tax/wht-certificates'); // P3
  });
  it('matches the longest list route, and only on a segment boundary', () => {
    expect(matchNavItem('/sales/tax-invoices/abc')?.item.key).toBe('taxInvoices');
    expect(matchNavItem('/sales/tax-invoicesX')).toBeUndefined();
    expect(matchNavItem('/')?.item.key).toBe('home');
    expect(matchNavItem('/nope')).toBeUndefined();
  });
});
