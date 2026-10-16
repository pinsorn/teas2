import type { RecordDescriptor } from '@/domain/records';

const f = (key: string) => `records.fields.${key}`;
const opt = (group: string, values: string[]) => values.map((value) => ({ value, labelKey: `records.options.${group}.${value}` }));

/** The banks a company account can be at (labels are messages `records.options.bankName.*`). */
export const BANKS = ['kbank', 'scb', 'bbl', 'ktb', 'bay', 'ttb', 'gsb'];

/** FN1 bank / cash account (SP0 §5.13: each has its own GL account). Detail is a custom static page (`/finance/bank-accounts/[id]`): the statement import and lines live there. */
export const bankAccount: RecordDescriptor = {
  kind: 'bank-account', basePath: '/finance/bank-accounts', titleKey: 'records.bank-account.title', searchPlaceholderKey: 'records.bank-account.search',
  permissions: { read: 'bank.read', manage: 'bank.manage' }, detail: true,
  columns: [
    { key: 'accountName', labelKey: f('accountName') }, { key: 'kind', labelKey: f('bankKind'), optionKey: 'bankKind' }, { key: 'bankName', labelKey: f('bankName'), optionKey: 'bankName' },
    { key: 'accountNo', labelKey: f('accountNo') }, { key: 'accountCode', labelKey: f('accountCode') }, { key: 'active', labelKey: f('active'), kind: 'bool' },
  ],
  fields: [
    { key: 'kind', kind: 'select', labelKey: f('bankKind'), required: true, defaultValue: 'bank', options: opt('bankKind', ['bank', 'cash']) },
    { key: 'bankName', kind: 'select', labelKey: f('bankName'), required: true, options: opt('bankName', BANKS), showWhen: { key: 'kind', equals: 'bank' } },
    { key: 'accountNo', kind: 'text', labelKey: f('accountNo'), required: true, showWhen: { key: 'kind', equals: 'bank' } },
    { key: 'accountName', kind: 'text', labelKey: f('accountName'), required: true },
    { key: 'accountCode', kind: 'account', labelKey: f('accountCode'), required: true, readOnlyAfterUse: true },
  ],
};
