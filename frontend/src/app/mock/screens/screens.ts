import type { FixtureKey } from '@/mocks/fixtures/ids';

/** A built screen. `route` is a path, or a fixture document (`base` defaults to the TI view route; `suffix` e.g. "/edit"). */
export interface Screen {
  name: string;
  route: string | { fixture: FixtureKey; base?: string; suffix?: string };
  company: 'vat' | 'nonvat' | 'both';
  states: boolean;
}

export const TI_BASE = '/sales/tax-invoices';
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
  { name: 'styleGuide', route: '/style-guide', company: 'both', states: false },
];
