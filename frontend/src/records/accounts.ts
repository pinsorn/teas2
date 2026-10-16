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
/** [SP-R] placeholder statutory lines: the DBD financial-statement format and the ภ.ง.ด.50 schedule boxes, as data (labels are messages `records.options.dbdLine.*` / `pnd50Box.*`). */
export const DBD_LINES = ['bs-cash', 'bs-receivables', 'bs-prepaid', 'bs-tax-asset', 'bs-other-current', 'bs-ppe', 'bs-accum-dep', 'bs-payables', 'bs-accrued', 'bs-tax-payable',
  'bs-deposits-received', 'bs-payroll-payable', 'bs-capital', 'bs-retained', 'pl-revenue', 'pl-other-income', 'pl-cost', 'pl-selling-admin', 'pl-other-expense', 'pl-finance-cost', 'pl-income-tax'] as const;
export const PND50_BOXES = ['p50-revenue', 'p50-other-income', 'p50-cost', 'p50-expense', 'p50-nondeductible'] as const;

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
