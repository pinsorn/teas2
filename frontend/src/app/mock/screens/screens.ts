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
export const IV_BASE = '/sales/invoices';
export const BL_BASE = '/sales/billing-statements';
export const RC_BASE = '/sales/receipts';
export const CN_BASE = '/sales/credit-notes';
export const DN_BASE = '/sales/debit-notes';
export const PO_BASE = '/purchases/purchase-orders';
export const PB_BASE = '/purchases/bills';
export const PCN_BASE = '/purchases/vendor-notes';
export const PDN_BASE = '/purchases/vendor-debit-notes';
export const PV_BASE = '/purchases/payment-vouchers';
export const EX_BASE = '/purchases/expense-claims';
export const WT_BASE = '/tax/wht-certificates';
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
  { name: 'poList', route: PO_BASE, company: 'both', states: true },
  { name: 'poNew', route: `${PO_BASE}/new`, company: 'both', states: true },
  { name: 'poDraft', route: { fixture: 'poDraft', base: PO_BASE }, company: 'vat', states: true },
  { name: 'poSent', route: { fixture: 'poSent', base: PO_BASE }, company: 'vat', states: true },
  { name: 'poPartlyBilled', route: { fixture: 'poPartlyBilled', base: PO_BASE }, company: 'vat', states: true },
  { name: 'poClosed', route: { fixture: 'poClosed', base: PO_BASE }, company: 'vat', states: true },
  { name: 'poPrint', route: { fixture: 'poSent', base: '/print/PO' }, company: 'vat', states: false },
  { name: 'npoIssued', route: { fixture: 'npoIssued', base: PO_BASE }, company: 'nonvat', states: true },
  { name: 'pbList', route: PB_BASE, company: 'both', states: true },
  { name: 'pbNew', route: `${PB_BASE}/new`, company: 'both', states: true },
  { name: 'pbDraft', route: { fixture: 'pbDraft', base: PB_BASE }, company: 'vat', states: true },
  { name: 'pbMixedVat', route: { fixture: 'pbMixedVat', base: PB_BASE }, company: 'vat', states: true },
  { name: 'pbFromPo', route: { fixture: 'pbFromPo', base: PB_BASE }, company: 'vat', states: true },
  { name: 'pbIncomplete', route: { fixture: 'pbIncomplete', base: PB_BASE }, company: 'vat', states: true },
  { name: 'npbVatToCost', route: { fixture: 'npbVatToCost', base: PB_BASE }, company: 'nonvat', states: true },
  { name: 'pcnList', route: PCN_BASE, company: 'both', states: true },
  { name: 'pcnIssued', route: { fixture: 'pcnIssued', base: PCN_BASE }, company: 'vat', states: true },
  { name: 'pdnList', route: PDN_BASE, company: 'both', states: true },
  { name: 'pdnIssued', route: { fixture: 'pdnIssued', base: PDN_BASE }, company: 'vat', states: true },
  { name: 'pvList', route: PV_BASE, company: 'both', states: true },
  { name: 'pvNew', route: `${PV_BASE}/new`, company: 'both', states: true },
  { name: 'pvMultiWt', route: { fixture: 'pvMultiWt', base: PV_BASE }, company: 'vat', states: true },
  { name: 'pvGrossUp', route: { fixture: 'pvGrossUp', base: PV_BASE }, company: 'vat', states: true },
  { name: 'pvForeign', route: { fixture: 'pvForeign', base: PV_BASE }, company: 'vat', states: true },
  { name: 'pvCancelled', route: { fixture: 'pvCancelled', base: PV_BASE }, company: 'vat', states: true },
  { name: 'pvPrint', route: { fixture: 'pvMultiWt', base: '/print/PV' }, company: 'vat', states: false },
  { name: 'exList', route: EX_BASE, company: 'both', states: true },
  { name: 'exNew', route: `${EX_BASE}/new`, company: 'both', states: true },
  { name: 'exDraft', route: { fixture: 'exDraft', base: EX_BASE }, company: 'vat', states: true },
  { name: 'exPending', route: { fixture: 'exPending', base: EX_BASE }, company: 'vat', states: true },
  { name: 'exApproved', route: { fixture: 'exApproved', base: EX_BASE }, company: 'vat', states: true },
  { name: 'exUnpaid', route: { fixture: 'exUnpaid', base: EX_BASE }, company: 'vat', states: true },
  { name: 'exPaid', route: { fixture: 'exPaid', base: EX_BASE }, company: 'vat', states: true },
  { name: 'exForfeit', route: { fixture: 'exForfeit', base: EX_BASE }, company: 'vat', states: true },
  { name: 'nexIssued', route: { fixture: 'nexIssued', base: EX_BASE }, company: 'nonvat', states: true },
  { name: 'exPrint', route: { fixture: 'exUnpaid', base: '/print/EX' }, company: 'vat', states: false },
  { name: 'wtList', route: WT_BASE, company: 'both', states: true },
  { name: 'wtIssued', route: { fixture: 'wtIssued', base: WT_BASE }, company: 'vat', states: true },
  { name: 'wtCancelled', route: { fixture: 'wtCancelled', base: WT_BASE }, company: 'vat', states: true },
  { name: 'wtPrint', route: { fixture: 'wtIssued', base: '/print/WT' }, company: 'vat', states: false },
  { name: 'ivList', route: IV_BASE, company: 'nonvat', states: true },
  { name: 'ivNew', route: `${IV_BASE}/new`, company: 'nonvat', states: true },
  { name: 'ivDraft', route: { fixture: 'ivDraft', base: IV_BASE }, company: 'nonvat', states: true },
  { name: 'ivEdit', route: { fixture: 'ivDraft', base: IV_BASE, suffix: '/edit' }, company: 'nonvat', states: true },
  { name: 'ivIssued', route: { fixture: 'ivIssuedUnpaid', base: IV_BASE }, company: 'nonvat', states: true },
  { name: 'ivPartly', route: { fixture: 'ivPartly', base: IV_BASE }, company: 'nonvat', states: true },
  { name: 'ivSettled', route: { fixture: 'ivSettled', base: IV_BASE }, company: 'nonvat', states: true },
  { name: 'ivPrint', route: { fixture: 'ivIssuedUnpaid', base: '/print/IV' }, company: 'nonvat', states: false },
  { name: 'blList', route: BL_BASE, company: 'both', states: true },
  { name: 'blNew', route: `${BL_BASE}/new`, company: 'both', states: true },
  { name: 'blVat', route: { fixture: 'blVat', base: BL_BASE }, company: 'vat', states: true },
  { name: 'blNonVat', route: { fixture: 'blNonVat', base: BL_BASE }, company: 'nonvat', states: true },
  { name: 'blPrint', route: { fixture: 'blVat', base: '/print/BL' }, company: 'vat', states: false },
  { name: 'rcList', route: RC_BASE, company: 'both', states: true },
  { name: 'rcNew', route: `${RC_BASE}/new`, company: 'both', states: true },
  { name: 'rcMulti', route: { fixture: 'rcMulti', base: RC_BASE }, company: 'vat', states: true },
  { name: 'rcNoCert', route: { fixture: 'rcNoCert', base: RC_BASE }, company: 'vat', states: true },
  { name: 'rcDeposit', route: { fixture: 'rcDeposit', base: RC_BASE }, company: 'vat', states: true },
  { name: 'nrcCashBill', route: { fixture: 'nrcCashBill', base: RC_BASE }, company: 'nonvat', states: true },
  { name: 'rcPrint', route: { fixture: 'rcMulti', base: '/print/RC' }, company: 'vat', states: false },
  { name: 'nrcPrint', route: { fixture: 'nrcCashBill', base: '/print/RC' }, company: 'nonvat', states: false },
  { name: 'cnList', route: CN_BASE, company: 'vat', states: true },
  { name: 'cnNew', route: `${CN_BASE}/new`, company: 'vat', states: true },
  { name: 'cnIssued', route: { fixture: 'cnIssued', base: CN_BASE }, company: 'vat', states: true },
  { name: 'cnPrint', route: { fixture: 'cnIssued', base: '/print/CN' }, company: 'vat', states: false },
  { name: 'dnList', route: DN_BASE, company: 'vat', states: true },
  { name: 'dnIssued', route: { fixture: 'dnIssued', base: DN_BASE }, company: 'vat', states: true },
  { name: 'dnPrint', route: { fixture: 'dnIssued', base: '/print/DN' }, company: 'vat', states: false },
  { name: 'tiCreditedToZero', route: { fixture: 'tiCreditedToZero' }, company: 'vat', states: true },
  { name: 'trialBalance', route: '/reports/financial-statements', company: 'both', states: true },
  { name: 'customers', route: '/master/customers', company: 'both', states: true },
  { name: 'customerView', route: '/master/customers/pc-01', company: 'vat', states: true },
  { name: 'vendors', route: '/master/vendors', company: 'both', states: true },
  { name: 'items', route: '/master/items', company: 'both', states: true },
  { name: 'styleGuide', route: '/style-guide', company: 'both', states: false },
];
