import type { RecordDescriptor } from '@/domain/records';

const f = (key: string) => `records.fields.${key}`;
const opt = (group: string, values: string[]) => values.map((value) => ({ value, labelKey: `records.options.${group}.${value}` }));

/** The mock `expense-categories` fixture's codes (labels are messages); ST2 turns this into a server-owned list. */
export const EXPENSE_CATEGORY_CODES = ['rent', 'services', 'advertising', 'transport', 'entertainment', 'supplies', 'capex-equipment', 'cost-of-sales', 'prepaid'];

export const item: RecordDescriptor = {
  kind: 'item', basePath: '/master/items', titleKey: 'records.item.title', searchPlaceholderKey: 'records.item.search',
  permissions: { read: 'item.read', manage: 'item.manage' }, detail: false,
  columns: [
    { key: 'code', labelKey: f('code') }, { key: 'name', labelKey: f('name') }, { key: 'kind', labelKey: f('kind'), optionKey: 'itemKind' },
    { key: 'unit', labelKey: f('unit') }, { key: 'unitPrice', labelKey: f('unitPrice'), kind: 'money', align: 'end' },
    { key: 'taxCode', labelKey: f('taxCode'), optionKey: 'taxCode' }, { key: 'usage', labelKey: f('usage'), optionKey: 'itemUsage' },
    { key: 'active', labelKey: f('active'), kind: 'bool' },
  ],
  fields: [
    { key: 'kind', kind: 'select', labelKey: f('kind'), required: true, options: opt('itemKind', ['good', 'service']) },
    { key: 'code', kind: 'text', labelKey: f('code'), required: true, readOnlyAfterUse: true },
    { key: 'name', kind: 'text', labelKey: f('name'), required: true },
    { key: 'unit', kind: 'text', labelKey: f('unit'), required: true },
    { key: 'unitPrice', kind: 'money', labelKey: f('unitPrice') },
    // a non-VAT company has no VAT to choose: the form hides this and the server stores EX
    { key: 'taxCode', kind: 'select', labelKey: f('taxCode'), vat: 'vat-only', defaultValue: 'S7', options: opt('taxCode', ['S7', 'Z0', 'EX']) },
    { key: 'whtTypeCode', kind: 'select', labelKey: f('whtTypeCode'), optionsFrom: 'wht-types', showWhen: { key: 'kind', equals: 'service' } },
    { key: 'usageSales', kind: 'bool', labelKey: f('usageSales'), defaultValue: true },
    { key: 'usagePurchase', kind: 'bool', labelKey: f('usagePurchase') },
    { key: 'expenseCategory', kind: 'select', labelKey: f('expenseCategory'), showWhen: { key: 'usagePurchase', equals: true },
      options: opt('expenseCategory', EXPENSE_CATEGORY_CODES) },
  ],
};
