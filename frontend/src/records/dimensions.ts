import type { RecordDescriptor } from '@/domain/records';
import { api } from '@/lib/api/client';

const f = (key: string) => `settings.dimensions.${key}`;

export type DimensionRule = 'required' | 'optional' | 'forbidden';
export interface DimensionValueRow { code: string; nameTh: string; active: boolean; version: number; inUse: boolean }
export interface DimensionTypeRow { key: string; nameTh: string; version: number; inUse: boolean; values: DimensionValueRow[] }
/** `GET /settings/dimensions` (any signed-in user: the document editor offers these). */
export interface DimensionsView { maxTypes: number; types: DimensionTypeRow[] }
/** One postable account and what it demands of each dimension type (absent = optional). */
export interface AccountRuleRow { code: string; nameTh: string; version: number; rules: Record<string, DimensionRule> }

const B = '/settings/dimensions';
/** The wire of the dimensions (read: any signed-in user; write and the account rules: settings.manage). */
export const dimensionApi = {
  list: () => api<DimensionsView>('GET', B),
  createType: (body: Record<string, unknown>) => api<DimensionTypeRow>('POST', B, body),
  updateType: (key: string, body: Record<string, unknown>) => api<DimensionTypeRow>('PUT', `${B}/${key}`, body),
  removeType: (key: string, version: number) => api<{ ok: true }>('DELETE', `${B}/${key}?version=${version}`),
  createValue: (key: string, body: Record<string, unknown>) => api<DimensionValueRow>('POST', `${B}/${key}/values`, body),
  updateValue: (key: string, code: string, body: Record<string, unknown>) => api<DimensionValueRow>('PUT', `${B}/${key}/values/${encodeURIComponent(code)}`, body),
  removeValue: (key: string, code: string, version: number) => api<{ ok: true }>('DELETE', `${B}/${key}/values/${encodeURIComponent(code)}?version=${version}`),
  accountRules: () => api<{ items: AccountRuleRow[] }>('GET', `${B}/account-rules`),
  setAccountRules: (code: string, body: { rules: Record<string, DimensionRule>; version: number }) => api<AccountRuleRow>('PUT', `${B}/account-rules/${code}`, body),
};

/** ST2 dimensions (SP0 §5.6): up to four types, each with values; per-account rules. Metadata for the settings page (custom: types, values and the account matrix are commands); wire `/settings/dimensions`. */
export const dimension: RecordDescriptor = {
  kind: 'dimension', basePath: '/settings/dimensions', titleKey: 'records.dimension.title', searchPlaceholderKey: 'records.dimension.search',
  permissions: { read: 'settings.manage', manage: 'settings.manage' }, detail: false,
  columns: [{ key: 'nameTh', labelKey: f('columns.name') }, { key: 'key', labelKey: f('columns.key') }, { key: 'values', labelKey: f('columns.values') }],
  fields: [
    { key: 'key', kind: 'text', labelKey: f('fields.key'), required: true, readOnlyAfterUse: true },
    { key: 'nameTh', kind: 'text', labelKey: f('fields.name'), required: true },
  ],
};
