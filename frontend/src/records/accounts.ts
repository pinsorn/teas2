import type { RecordDescriptor } from '@/domain/records';

const f = (key: string) => `records.fields.${key}`;
const opt = (group: string, values: readonly string[]) => values.map((value) => ({ value, labelKey: `records.options.${group}.${value}` }));

/** SP0 §5.4: the 12 classes the financial statements are built from, each in one of the five statement groups (a header account's children may be any class of its group). */
export const ACCOUNT_CLASSES = ['current-asset', 'non-current-asset', 'current-liability', 'non-current-liability', 'equity', 'sales-revenue', 'other-income',
  'cost-of-sales', 'selling-admin-expense', 'other-expense', 'finance-cost', 'income-tax'] as const;
export type AccountClass = (typeof ACCOUNT_CLASSES)[number];
export type AccountGroup = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
export const GROUP_OF: Record<AccountClass, AccountGroup> = {
  'current-asset': 'asset', 'non-current-asset': 'asset', 'current-liability': 'liability', 'non-current-liability': 'liability', equity: 'equity',
  'sales-revenue': 'revenue', 'other-income': 'revenue', 'cost-of-sales': 'expense', 'selling-admin-expense': 'expense', 'other-expense': 'expense', 'finance-cost': 'expense', 'income-tax': 'expense',
};
/** The sub-classes (they decide what an account is for: cash / bank box, receivable, tax, payroll... see `controlExit`), each belonging to one group; `header` fits any. */
export const SUB_CLASS_GROUP: Record<string, AccountGroup | 'any'> = {
  header: 'any',
  cash: 'asset', bank: 'asset', receivable: 'asset', prepayment: 'asset', 'tax-asset': 'asset', 'current-asset': 'asset', 'fixed-asset': 'asset', 'accumulated-depreciation': 'asset',
  payable: 'liability', accrual: 'liability', 'tax-liability': 'liability', deposit: 'liability', 'payroll-liability': 'liability', 'current-liability': 'liability',
  capital: 'equity', retained: 'equity', 'current-year': 'equity', opening: 'equity',
  sales: 'revenue', 'contra-sales': 'revenue', 'other-income': 'revenue',
  expense: 'expense', 'payroll-expense': 'expense',
};
/**
 * Statutory lines as data (labels are messages `records.options.dbdLine.*` / `pnd50Box.*`). Source: docs/research/tax/dbd-fs-lines-and-pnd50.md (Ham's rulings 2026-10-17).
 * DBD: the balance-sheet lines of แบบ 2 (ประกาศกรมพัฒนาธุรกิจการค้า เรื่อง รายการย่อที่ต้องมีในงบการเงิน พ.ศ. 2566) in print order, then the profit-and-loss lines of format 2.7
 * (by function, multi-step) in PRINT order (not number order: 1, 3, 2, 4...). Labels carry the official number and Thai wording; 5.1.1 registered capital is a disclosure, not a balance, so it is no line.
 * ภ.ง.ด.50 (ปี 2568): the closed form: รายการที่ 2.1, the sub-lines of 3-7 the note lists (3.1/3.8 and 4.1/4.5/4.7/4.16 are inventory balances, listed but never seeded), 8.1; labels carry the e-filing field in [..].
 * The English labels are plain translations, UNOFFICIAL (the DBD publishes none); keys are stable kebab-case from the meaning, never the number.
 */
export const DBD_LINES = [
  'bs-cash-and-equivalents', 'bs-short-term-investments', 'bs-trade-and-other-current-receivables', 'bs-contract-assets-current', 'bs-short-term-loans-given',
  'bs-inventories', 'bs-current-tax-asset', 'bs-biological-assets-current', 'bs-other-current-assets', 'bs-held-for-sale-current', 'bs-pledged-deposits', 'bs-investment-subsidiaries',
  'bs-investment-joint-ventures', 'bs-investment-associates', 'bs-other-long-term-investments', 'bs-trade-and-other-noncurrent-receivables', 'bs-long-term-loans-given',
  'bs-contract-assets-noncurrent', 'bs-investment-property', 'bs-ppe', 'bs-goodwill', 'bs-intangible-assets', 'bs-biological-assets-noncurrent', 'bs-deferred-tax-asset',
  'bs-other-noncurrent-assets', 'bs-held-for-sale-noncurrent', 'bs-overdrafts-and-bank-loans-short', 'bs-trade-and-other-current-payables', 'bs-billings-in-excess-current',
  'bs-long-term-debt-current-portion', 'bs-finance-lease-current-portion', 'bs-short-term-loans-received', 'bs-income-tax-payable', 'bs-employee-benefit-provision-current',
  'bs-other-short-term-provisions', 'bs-other-current-liabilities', 'bs-long-term-borrowings', 'bs-finance-lease-liabilities', 'bs-trade-and-other-noncurrent-payables',
  'bs-billings-in-excess-noncurrent', 'bs-deferred-tax-liability', 'bs-employee-benefit-provision-noncurrent', 'bs-other-long-term-provisions', 'bs-other-noncurrent-liabilities',
  'bs-paid-up-capital', 'bs-share-premium', 'bs-other-capital-surplus', 'bs-legal-reserve', 'bs-other-appropriated', 'bs-unappropriated', 'bs-other-equity-interest',
  'bs-other-equity-components', 'bs-non-controlling-interests',
  'pl-revenue-from-sales-or-services', 'pl-cost-of-sales-or-services', 'pl-other-income', 'pl-selling-expenses', 'pl-administrative-expenses', 'pl-other-expenses',
  'pl-equity-method-share', 'pl-finance-costs', 'pl-income-tax',
] as const;
export const PND50_BOXES = [
  'p50-revenue-direct', 'p50-cogs-opening-inventory', 'p50-cogs-purchases', 'p50-cogs-goodwill-rights', 'p50-cogs-purchase-expenses', 'p50-cogs-closing-inventory',
  'p50-prod-opening-materials', 'p50-prod-materials-purchases', 'p50-prod-materials-purchase-expenses', 'p50-prod-closing-materials', 'p50-prod-opening-wip',
  'p50-prod-wages', 'p50-prod-goodwill-rights', 'p50-prod-fuel-energy', 'p50-prod-packaging', 'p50-prod-depreciation', 'p50-prod-other', 'p50-prod-closing-wip',
  'p50-other-income-disposal-gain', 'p50-other-income-fx-gain', 'p50-other-income-interest', 'p50-other-income-dividend', 'p50-other-income-tax-refund', 'p50-other-income-misc',
  'p50-other-expense-disposal-loss', 'p50-other-expense-fx-loss', 'p50-other-expense-finance-cost', 'p50-other-expense-misc', 'p50-sga-employee', 'p50-sga-director-pay',
  'p50-sga-utilities', 'p50-sga-travel', 'p50-sga-freight', 'p50-sga-rent', 'p50-sga-repairs', 'p50-sga-entertainment', 'p50-sga-commission-advertising', 'p50-sga-specific-business-tax',
  'p50-sga-other-taxes', 'p50-sga-finance-cost', 'p50-sga-bookkeeping', 'p50-sga-audit', 'p50-sga-political-donation', 'p50-sga-charity', 'p50-sga-education-sport',
  'p50-sga-advisory-fees', 'p50-sga-other-fees', 'p50-sga-bad-debt', 'p50-sga-depreciation', 'p50-sga-other', 'p50-sga-double-deduction', 'p50-income-tax',
] as const;

/** AC2 chart of accounts (SP0 §5.4): a tree (`TreeRecordList`), edited in a dialog. Frozen once used (`readOnlyAfterUse` = the account has a journal line); `parent` is a header account of the same group (a used account may only move under a header of its present parent's class). Dimension rules are shown, edited in ST2. */
export const account: RecordDescriptor = {
  kind: 'account', basePath: '/accounting/chart-of-accounts', titleKey: 'records.account.title', searchPlaceholderKey: 'records.account.search',
  permissions: { read: 'ledger.read', manage: 'ledger.coa.manage' }, detail: false, tree: true,
  columns: [
    { key: 'code', labelKey: f('code') }, { key: 'name', labelKey: f('nameTh') }, { key: 'class', labelKey: f('accountClass'), optionKey: 'accountClass' },
    { key: 'subClass', labelKey: f('subClass'), optionKey: 'accountSubClass' },
    { key: 'dimensionRules', labelKey: f('dimensionRules') }, { key: 'active', labelKey: f('active'), kind: 'bool' },
  ],
  fields: [
    { key: 'code', kind: 'text', labelKey: f('code'), required: true, readOnlyAfterUse: true },
    { key: 'nameTh', kind: 'text', labelKey: f('nameTh'), required: true },
    { key: 'nameEn', kind: 'text', labelKey: f('nameEn') },
    { key: 'parent', kind: 'select', labelKey: f('parent'), optionsFrom: 'account-headers' },
    { key: 'postable', kind: 'bool', labelKey: f('postable'), defaultValue: true, readOnlyAfterUse: true },
    { key: 'class', kind: 'select', labelKey: f('accountClass'), required: true, readOnlyAfterUse: true, options: opt('accountClass', ACCOUNT_CLASSES) },
    { key: 'subClass', kind: 'select', labelKey: f('subClass'), required: true, readOnlyAfterUse: true, options: opt('accountSubClass', Object.keys(SUB_CLASS_GROUP)) },
    { key: 'dbdLine', kind: 'select', labelKey: f('dbdLine'), options: opt('dbdLine', DBD_LINES) },
    { key: 'pnd50Box', kind: 'select', labelKey: f('pnd50Box'), options: opt('pnd50Box', PND50_BOXES) },
  ],
};
