import type { DocType } from '@/domain/types';

export interface NavItem { key: string; labelKey: string; href: string; permission?: string; vatOnly?: boolean; nonVatOnly?: boolean }
export interface NavGroup { key: string; labelKey: string; items: NavItem[] }

const item = (key: string, href: string, permission?: string, flags: Pick<NavItem, 'vatOnly' | 'nonVatOnly'> = {}): NavItem =>
  ({ key, labelKey: `nav.items.${key}`, href, permission, ...flags });
const group = (key: string, items: NavItem[]): NavGroup => ({ key, labelKey: `nav.groups.${key}`, items });
const doc = (key: string, href: string, type: DocType, flags?: Pick<NavItem, 'vatOnly' | 'nonVatOnly'>) => item(key, href, `doc.${type}.read`, flags);
const LEDGER = 'ledger.read';
const TAX = 'tax.read';
const SETTINGS = 'settings.manage';
const USERS = 'users.manage';
const POSTING = 'ledger.posting.manage';
const BANK = 'bank.read';

/** SP0 §9.1. Labels live in the messages under `nav.*`. */
export const NAV: NavGroup[] = [
  group('home', [item('home', '/')]),
  group('sales', [
    doc('quotations', '/sales/quotations', 'QT'),
    doc('salesOrders', '/sales/sales-orders', 'SO'),
    doc('deliveryOrders', '/sales/delivery-orders', 'DO'),
    item('invoices', '/sales/invoices', 'doc.IV.read', { nonVatOnly: true }),
    doc('billingStatements', '/sales/billing-statements', 'BL'),
    doc('taxInvoices', '/sales/tax-invoices', 'TI', { vatOnly: true }),
    doc('receipts', '/sales/receipts', 'RC'),
    doc('creditNotes', '/sales/credit-notes', 'CN', { vatOnly: true }),
    doc('debitNotes', '/sales/debit-notes', 'DN', { vatOnly: true }),
  ]),
  group('purchases', [
    doc('purchaseOrders', '/purchases/purchase-orders', 'PO'),
    doc('bills', '/purchases/bills', 'PB'),
    doc('paymentVouchers', '/purchases/payment-vouchers', 'PV'),
    doc('vendorNotes', '/purchases/vendor-notes', 'PCN'),
    doc('vendorDebitNotes', '/purchases/vendor-debit-notes', 'PDN'),
    doc('expenseClaims', '/purchases/expense-claims', 'EX'),
  ]),
  group('finance', [item('bankAccounts', '/finance/bank-accounts', BANK), item('deposits', '/finance/deposits', BANK), item('settlements', '/finance/settlements', BANK)]),
  group('accounting', [
    item('journals', '/accounting/journals', LEDGER),
    doc('journalVouchers', '/accounting/journal-vouchers', 'JV'),
    item('chartOfAccounts', '/accounting/chart-of-accounts', LEDGER),
    doc('openingBalances', '/accounting/opening-balances', 'OB'),
    item('schedules', '/accounting/schedules', LEDGER),
    doc('fixedAssets', '/accounting/fixed-assets', 'FA'),
    doc('depreciation', '/accounting/depreciation-runs', 'DP'),
    item('periodClose', '/accounting/period-close', LEDGER),
  ]),
  group('tax', [
    item('taxSummary', '/tax/summary', TAX),
    item('vat', '/tax/vat', TAX, { vatOnly: true }),
    item('wht', '/tax/wht', TAX),
    doc('whtCertificates', '/tax/wht-certificates', 'WT'),
    item('cit', '/tax/cit', TAX),
    item('taxForms', '/tax/forms', TAX),
  ]),
  group('payroll', [
    item('employees', '/payroll/employees', 'employee.read'),
    doc('payrollRuns', '/payroll/runs', 'PR'),
    item('payrollFilings', '/payroll/filings', 'payroll.read'),
  ]),
  group('reports', [
    item('financialStatements', '/reports/financial-statements', 'report.read'),
    item('assetRegister', '/reports/asset-register', 'report.read'),
    item('receivablesPayables', '/reports/receivables-payables', 'report.arap.read'),
    item('salesPurchases', '/reports/sales-purchases', 'report.arap.read'),
    item('auditReport', '/reports/audit', 'audit.read'),
  ]),
  group('master', [
    item('customers', '/master/customers', 'party.read'),
    item('vendors', '/master/vendors', 'party.read'),
    item('items', '/master/items', 'item.read'),
  ]),
  group('settings', ['company', 'users', 'roles', 'posting', 'dimensions', 'tax', 'numbering', 'approvals', 'templates', 'connect']
    .map((s) => item(`settings${s[0].toUpperCase()}${s.slice(1)}`, `/settings/${s}`, s === 'users' || s === 'roles' ? USERS : s === 'posting' ? POSTING : SETTINGS))), // ST1: people and roles are the user administrator's; ST2: the posting rules are the accountant's
];

export function visibleNav(nav: NavGroup[], ctx: { permissions: string[]; vatRegistered: boolean }): NavGroup[] {
  const ok = (i: NavItem) =>
    (!i.permission || ctx.permissions.includes(i.permission)) && !(i.vatOnly && !ctx.vatRegistered) && !(i.nonVatOnly && ctx.vatRegistered);
  return nav.map((g) => ({ ...g, items: g.items.filter(ok) })).filter((g) => g.items.length > 0);
}

/** The nav item whose route is the longest prefix of `pathname` (document pages under a list route match their list). */
export function matchNavItem(pathname: string, nav: NavGroup[] = NAV): { group: NavGroup; item: NavItem } | undefined {
  let best: { group: NavGroup; item: NavItem } | undefined;
  for (const group of nav) for (const item of group.items) {
    const hit = item.href === '/' ? pathname === '/' : pathname === item.href || pathname.startsWith(`${item.href}/`);
    if (hit && (!best || item.href.length > best.item.href.length)) best = { group, item };
  }
  return best;
}
