import type { RecordDescriptor } from '@/domain/records';
import { api } from '@/lib/api/client';

const f = (key: string) => `settings.categories.${key}`;

export interface ExpenseCategoryItem {
  code: string; nameTh: string; accountCode?: string; recoverableVat: boolean; capex: boolean; assetClass?: string; defaultWhtType?: string; parent?: string; active: boolean; version: number; inUse: boolean;
}

export interface ExpenseCategoriesView { items: ExpenseCategoryItem[]; /** the asset classes a capex category can capitalise to */ assetClasses: string[] }
const B = '/settings/expense-categories';
/** The wire of the categories (read: any signed-in user; write: ledger.posting.manage). */
export const categoryApi = {
  list: () => api<ExpenseCategoriesView>('GET', B),
  create: (body: Record<string, unknown>) => api<ExpenseCategoryItem>('POST', B, body),
  update: (code: string, body: Record<string, unknown>) => api<ExpenseCategoryItem>('PUT', `${B}/${encodeURIComponent(code)}`, body),
  remove: (code: string, version: number) => api<{ ok: true }>('DELETE', `${B}/${encodeURIComponent(code)}?version=${version}`),
};

/** ST2 expense categories (SP0 §5.5): editable (TEAS 1 showed them read-only). Metadata for the settings page tab; wire `/settings/expense-categories` (the GET is open to every signed-in user: the line grid offers them). */
export const expenseCategory: RecordDescriptor = {
  kind: 'expense-category', basePath: '/settings/posting', titleKey: 'records.expenseCategory.title', searchPlaceholderKey: 'records.expenseCategory.search',
  permissions: { read: 'ledger.posting.manage', manage: 'ledger.posting.manage' }, detail: false,
  columns: [{ key: 'code', labelKey: f('columns.code') }, { key: 'nameTh', labelKey: f('columns.name') }, { key: 'accountCode', labelKey: f('columns.account') }, { key: 'recoverableVat', labelKey: f('columns.vat'), kind: 'bool' }, { key: 'capex', labelKey: f('columns.capex'), kind: 'bool' }],
  fields: [
    { key: 'code', kind: 'text', labelKey: f('fields.code'), required: true, readOnlyAfterUse: true },
    { key: 'nameTh', kind: 'text', labelKey: f('fields.name'), required: true },
    { key: 'accountCode', kind: 'account', labelKey: f('fields.account') },
    { key: 'recoverableVat', kind: 'bool', labelKey: f('fields.vat'), defaultValue: true },
    { key: 'capex', kind: 'bool', labelKey: f('fields.capex') },
    { key: 'assetClass', kind: 'text', labelKey: f('fields.assetClass'), showWhen: { key: 'capex', equals: true } },
    { key: 'defaultWhtType', kind: 'select', labelKey: f('fields.wht'), optionsFrom: 'wht-types' },
    { key: 'parent', kind: 'text', labelKey: f('fields.parent') },
  ],
};
