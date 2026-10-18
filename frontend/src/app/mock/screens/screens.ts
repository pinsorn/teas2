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
export const BANK_BASE = '/finance/bank-accounts';
export const SETTLEMENT_BASE = '/finance/settlements';
export const JV_BASE = '/accounting/journal-vouchers';
export const OB_BASE = '/accounting/opening-balances';
export const SCHEDULE_BASE = '/accounting/schedules';
export const FA_BASE = '/accounting/fixed-assets';
export const DP_BASE = '/accounting/depreciation-runs';
export const PR_BASE = '/payroll/runs';
export const EMP_BASE = '/payroll/employees';
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
  { name: 'plReport', route: '/reports/financial-statements?tab=pl', company: 'both', states: true },
  { name: 'bsReport', route: '/reports/financial-statements?tab=bs', company: 'both', states: true },
  { name: 'glReport', route: '/reports/financial-statements?tab=gl&account=1130', company: 'both', states: true },
  { name: 'assetRegisterReport', route: '/reports/asset-register', company: 'both', states: true },
  { name: 'arAging', route: '/reports/receivables-payables?tab=ar', company: 'both', states: true },
  { name: 'apAging', route: '/reports/receivables-payables?tab=ap', company: 'both', states: true },
  { name: 'customerStatement', route: '/reports/receivables-payables?tab=cs&party=pc-10', company: 'vat', states: true },
  { name: 'vendorLedger', route: '/reports/receivables-payables?tab=vl&party=pv-02', company: 'vat', states: true },
  { name: 'salesSummary', route: '/reports/sales-purchases?tab=sales', company: 'both', states: true },
  { name: 'purchaseSummary', route: '/reports/sales-purchases?tab=purchases', company: 'both', states: true },
  { name: 'outstandingPo', route: '/reports/sales-purchases?tab=po', company: 'both', states: true },
  { name: 'assetRegisterTab', route: '/reports/sales-purchases?tab=assets', company: 'both', states: true },
  { name: 'numberGaps', route: '/reports/audit?tab=gaps', company: 'both', states: true },
  { name: 'auditLog', route: '/reports/audit?tab=log', company: 'both', states: true },
  { name: 'reopenHistory', route: '/reports/audit?tab=reopen', company: 'both', states: true },
  { name: 'customers', route: '/master/customers', company: 'both', states: true },
  { name: 'customerView', route: '/master/customers/pc-01', company: 'vat', states: true },
  { name: 'vendors', route: '/master/vendors', company: 'both', states: true },
  { name: 'items', route: '/master/items', company: 'both', states: true },
  { name: 'bankList', route: BANK_BASE, company: 'both', states: true },
  { name: 'bankView', route: { fixture: 'bankKbank', base: BANK_BASE }, company: 'vat', states: true },
  { name: 'bankEmpty', route: { fixture: 'bankEmpty', base: BANK_BASE }, company: 'vat', states: true },
  { name: 'bankReconcile', route: { fixture: 'bankKbank', base: BANK_BASE, suffix: '?tab=reconcile' }, company: 'vat', states: true },
  { name: 'nbankView', route: { fixture: 'nbankKbank', base: BANK_BASE }, company: 'nonvat', states: true },
  { name: 'depositsPage', route: '/finance/deposits', company: 'both', states: true },
  { name: 'settlementsList', route: SETTLEMENT_BASE, company: 'both', states: true },
  { name: 'settlementPosted', route: `${SETTLEMENT_BASE}/stl-001`, company: 'vat', states: true }, // the seeded settlement: pc-05's deposit rc-dep2 applied to ti-dep2
  { name: 'rcDepositApplied', route: { fixture: 'rcDepositApplied', base: RC_BASE }, company: 'vat', states: true },
  { name: 'pvPrepayment', route: { fixture: 'pvPrepayment', base: PV_BASE }, company: 'vat', states: true },
  { name: 'jvList', route: JV_BASE, company: 'both', states: true },
  { name: 'jvNew', route: `${JV_BASE}/new`, company: 'both', states: true },
  { name: 'jvDraft', route: { fixture: 'jvDraftUnbalanced', base: JV_BASE }, company: 'vat', states: true },
  { name: 'jvAccrual', route: { fixture: 'jvAccrual', base: JV_BASE }, company: 'vat', states: true },
  { name: 'jvIssued', route: { fixture: 'jvIssued', base: JV_BASE }, company: 'vat', states: true },
  { name: 'jvReversal', route: { fixture: 'jvReversal', base: JV_BASE }, company: 'vat', states: true },
  { name: 'jvPrint', route: { fixture: 'jvAccrual', base: '/print/JV' }, company: 'vat', states: false },
  { name: 'njvIssued', route: { fixture: 'njvIssued', base: JV_BASE }, company: 'nonvat', states: true },
  { name: 'journalsList', route: '/accounting/journals', company: 'both', states: true },
  { name: 'coaList', route: '/accounting/chart-of-accounts', company: 'both', states: true },
  { name: 'obList', route: OB_BASE, company: 'both', states: true },
  { name: 'obNew', route: `${OB_BASE}/new`, company: 'vat', states: true },
  { name: 'obDraft', route: { fixture: 'obDraft', base: OB_BASE, suffix: '/edit' }, company: 'vat', states: true },
  { name: 'obIssued', route: { fixture: 'obIssued', base: OB_BASE }, company: 'nonvat', states: true },
  { name: 'schedulesList', route: SCHEDULE_BASE, company: 'both', states: true },
  { name: 'scheduleAmortisation', route: { fixture: 'schedAmortisation', base: SCHEDULE_BASE }, company: 'vat', states: true },
  { name: 'scheduleRecurringTi', route: { fixture: 'schedRecurringTi', base: SCHEDULE_BASE }, company: 'vat', states: true },
  { name: 'nscheduleRecurring', route: { fixture: 'nschedRecurring', base: SCHEDULE_BASE }, company: 'nonvat', states: true },
  { name: 'faList', route: FA_BASE, company: 'both', states: true },
  { name: 'faNew', route: `${FA_BASE}/new`, company: 'both', states: true },
  { name: 'faActive', route: { fixture: 'faActive', base: FA_BASE }, company: 'vat', states: true },
  { name: 'faDisposed', route: { fixture: 'faDisposed', base: FA_BASE }, company: 'vat', states: true },
  { name: 'nfaActive', route: { fixture: 'nfaActive', base: FA_BASE }, company: 'nonvat', states: true },
  { name: 'faCar', route: { fixture: 'faCar', base: FA_BASE }, company: 'nonvat', states: true },
  { name: 'dpList', route: DP_BASE, company: 'both', states: true },
  { name: 'dpNew', route: `${DP_BASE}/new`, company: 'both', states: true },
  { name: 'dpRun', route: { fixture: 'dpRun', base: DP_BASE }, company: 'vat', states: true },
  { name: 'employeesList', route: EMP_BASE, company: 'both', states: true },
  { name: 'employeeJoiner', route: { fixture: 'empJoiner', base: EMP_BASE }, company: 'vat', states: true },
  { name: 'prList', route: PR_BASE, company: 'both', states: true },
  { name: 'prNew', route: `${PR_BASE}/new`, company: 'both', states: true },
  { name: 'prDraft', route: { fixture: 'prDraft', base: PR_BASE }, company: 'vat', states: true },
  { name: 'prIssued', route: { fixture: 'prIssued', base: PR_BASE }, company: 'vat', states: true },
  { name: 'prPaid', route: { fixture: 'prPaid', base: PR_BASE }, company: 'vat', states: true },
  { name: 'nprIssued', route: { fixture: 'nprIssued', base: PR_BASE }, company: 'nonvat', states: true },
  { name: 'periodClose', route: '/accounting/period-close', company: 'both', states: true },
  { name: 'vat', route: '/tax/vat', company: 'vat', states: true }, // TX1: the month after the last one filed
  { name: 'vatFiled', route: '/tax/vat?period=2026-08', company: 'vat', states: true }, // finalized: the frozen snapshot
  { name: 'vatBlocked', route: '/tax/vat?period=2026-10', company: 'vat', states: true }, // drafts and September still open
  { name: 'vatOutputRegister', route: '/tax/vat?tab=output&period=2026-09', company: 'vat', states: true },
  { name: 'vatInputRegister', route: '/tax/vat?tab=input&period=2026-10', company: 'vat', states: true },
  { name: 'whtPnd3', route: '/tax/wht', company: 'both', states: true }, // TX2b: the hub opens on the ภ.ง.ด.3
  { name: 'whtPnd53Filed', route: '/tax/wht?tab=pnd53&period=2026-09', company: 'both', states: true }, // finalized: the frozen snapshot with its attachment
  { name: 'whtPnd53Blocked', route: '/tax/wht?tab=pnd53&period=2026-10', company: 'both', states: true },
  { name: 'whtPnd2', route: '/tax/wht?tab=pnd2', company: 'both', states: true },
  { name: 'whtPnd54', route: '/tax/wht?tab=pnd54&period=2026-10', company: 'both', states: true },
  { name: 'whtPp36', route: '/tax/wht?tab=pp36&period=2026-10', company: 'both', states: true },
  { name: 'whtWithheld', route: '/tax/wht?tab=withheld', company: 'both', states: true },
  { name: 'whtMissingCert', route: '/tax/wht?tab=missing', company: 'both', states: true },
  { name: 'payrollFilingsPnd1', route: '/payroll/filings?tab=pnd1&period=2026-09', company: 'both', states: true }, // PY3: September's ภ.ง.ด.1 (a draft: finalizable for the VAT company)
  { name: 'payrollFilingsPnd1Filed', route: '/payroll/filings?tab=pnd1&period=2026-08', company: 'both', states: true }, // finalized: the frozen snapshot, payable
  { name: 'payrollFilingsPnd1a', route: '/payroll/filings?tab=pnd1a&period=2025', company: 'both', states: true }, // the non-VAT company's 2025 is its opening balance only
  { name: 'payrollFilingsSso', route: '/payroll/filings?tab=sso&period=2026-09', company: 'both', states: true }, // the non-VAT company has no SSO employer account: blocked, exit = company settings
  { name: 'payrollFilingsSsoFiled', route: '/payroll/filings?tab=sso&period=2026-08', company: 'both', states: true },
  { name: 'payrollFilingsCert', route: '/payroll/filings?tab=cert&period=2025', company: 'both', states: true }, // the annual 50 ทวิ of the employees (empty until the ภ.ง.ด.1ก of the year is filed)
  { name: 'cit', route: '/tax/cit', company: 'both', states: true }, // TX3a: the ภ.ง.ด.50 of the last year that ended (2025: the year-end close is not done in the seed)
  { name: 'citPnd51', route: '/tax/cit?tab=pnd51&period=2026', company: 'both', states: true },
  { name: 'citYear2026', route: '/tax/cit?period=2026', company: 'both', states: true },
  { name: 'taxSummary', route: '/tax/summary', company: 'both', states: true }, // TX3b: twelve months of 2026; the non-VAT company also shows the threshold card at 85 %
  { name: 'taxForms', route: '/tax/forms', company: 'both', states: true },
  { name: 'taxFormPp01', route: '/tax/forms?print=PP01', company: 'both', states: false },
  { name: 'settingsCompany', route: '/settings/company?role=admin', company: 'both', states: true }, // ST1: admin only (accountant is forbidden)
  { name: 'settingsUsers', route: '/settings/users?role=admin', company: 'both', states: true },
  { name: 'settingsRoles', route: '/settings/roles?role=admin', company: 'both', states: true },
  { name: 'settingsPosting', route: '/settings/posting?role=accountant', company: 'both', states: true }, // ST2: the accountant's (ledger.posting.manage); the operator is forbidden
  { name: 'settingsDimensions', route: '/settings/dimensions?role=admin', company: 'both', states: true }, // ST2: settings.manage; the accountant is forbidden
  { name: 'styleGuide', route: '/style-guide', company: 'both', states: false },
];
