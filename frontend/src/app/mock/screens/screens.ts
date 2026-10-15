import type { FixtureKey } from '@/mocks/fixtures/ids';

/** A built screen. `route` is a path, or a fixture document (`base` defaults to the TI view route; `suffix` e.g. "/edit"). */
export interface Screen {
  name: string;
  route: string | { fixture: FixtureKey; base?: string; suffix?: string };
  company: 'vat' | 'nonvat' | 'both';
  states: boolean;
}

export const TI_BASE = '/sales/tax-invoices';
export const QT_BASE = '/sales/quotations';
export const SO_BASE = '/sales/sales-orders';
export const DO_BASE = '/sales/delivery-orders';
// names are keys of messages `screens.name.*`; fixture keys live in src/mocks/fixtures/ids.ts (later tasks append their screens here)
export const SCREENS: Screen[] = [
  { name: 'home', route: '/', company: 'both', states: true },
  { name: 'tiList', route: TI_BASE, company: 'vat', states: true },
  { name: 'tiNew', route: `${TI_BASE}/new`, company: 'vat', states: true },
  { name: 'tiDraft', route: { fixture: 'tiDraft' }, company: 'vat', states: true },
  { name: 'tiIssued', route: { fixture: 'tiIssuedUnpaid' }, company: 'vat', states: true },
  { name: 'tiLocked', route: { fixture: 'tiFilingLocked' }, company: 'vat', states: true },
  { name: 'tiReplaced', route: { fixture: 'tiReplaced' }, company: 'vat', states: true },
  { name: 'tiLong', route: { fixture: 'tiLong' }, company: 'vat', states: true },
  { name: 'tiEdit', route: { fixture: 'tiDraft', suffix: '/edit' }, company: 'vat', states: true },
  { name: 'print', route: { fixture: 'tiIssuedUnpaid', base: '/print/TI' }, company: 'vat', states: false },
  { name: 'printLong', route: { fixture: 'tiLong', base: '/print/TI' }, company: 'vat', states: false },
  { name: 'qtList', route: QT_BASE, company: 'both', states: true },
  { name: 'qtNew', route: `${QT_BASE}/new`, company: 'both', states: true },
  { name: 'qtDraft', route: { fixture: 'qtDraft', base: QT_BASE }, company: 'vat', states: true },
  { name: 'qtEdit', route: { fixture: 'qtDraft', base: QT_BASE, suffix: '/edit' }, company: 'vat', states: true },
  { name: 'qtIssued', route: { fixture: 'qtIssued', base: QT_BASE }, company: 'vat', states: true },
  { name: 'qtRejected', route: { fixture: 'qtRejected', base: QT_BASE }, company: 'vat', states: true },
  { name: 'qtCancelled', route: { fixture: 'qtCancelled', base: QT_BASE }, company: 'vat', states: true },
  { name: 'qtRevised', route: { fixture: 'qtRevised', base: QT_BASE }, company: 'vat', states: true },
  { name: 'qtPrint', route: { fixture: 'qtIssued', base: '/print/QT' }, company: 'vat', states: false },
  { name: 'nqtPrint', route: { fixture: 'nqtIssued', base: '/print/QT' }, company: 'nonvat', states: false },
  { name: 'soList', route: SO_BASE, company: 'both', states: true },
  { name: 'soNew', route: `${SO_BASE}/new`, company: 'both', states: true },
  { name: 'soPartlyDelivered', route: { fixture: 'soPartlyDelivered', base: SO_BASE }, company: 'vat', states: true },
  { name: 'soClosed', route: { fixture: 'soClosed', base: SO_BASE }, company: 'vat', states: true },
  { name: 'soPrint', route: { fixture: 'soPartlyDelivered', base: '/print/SO' }, company: 'vat', states: false },
  { name: 'doList', route: DO_BASE, company: 'both', states: true },
  { name: 'doDelivered', route: { fixture: 'doDelivered', base: DO_BASE }, company: 'vat', states: true },
  { name: 'doPrint', route: { fixture: 'doDelivered', base: '/print/DO' }, company: 'vat', states: false },
  { name: 'nsoIssued', route: { fixture: 'nsoIssued', base: SO_BASE }, company: 'nonvat', states: true },
  { name: 'ndoDelivered', route: { fixture: 'ndoDelivered', base: DO_BASE }, company: 'nonvat', states: true },
  { name: 'trialBalance', route: '/reports/financial-statements', company: 'both', states: true },
  { name: 'customers', route: '/master/customers', company: 'both', states: true },
  { name: 'customerView', route: '/master/customers/pc-01', company: 'vat', states: true },
  { name: 'vendors', route: '/master/vendors', company: 'both', states: true },
  { name: 'items', route: '/master/items', company: 'both', states: true },
  { name: 'styleGuide', route: '/style-guide', company: 'both', states: false },
];
