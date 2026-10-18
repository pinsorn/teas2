import type { RecordDescriptor } from '@/domain/records';
import type { DocType, JournalPreview } from '@/domain/types';
import { api } from '@/lib/api/client';

const f = (key: string) => `settings.posting.${key}`;

export const POSTING_LEVELS = ['item', 'category', 'partyGroup', 'docType', 'default'] as const;
export type PostingLevel = (typeof POSTING_LEVELS)[number];
export interface PostingRuleRow {
  id: string; level: PostingLevel; key?: string; role: string; accountCode: string; accountName: string; version: number;
  /** The default rule of a role cannot be deleted (every role keeps one). */ required: boolean;
}
/** `GET /settings/posting/rules`: the rules plus what the form needs - every role with the accounts it accepts (from the ONE class table the server saves by) and the account names. */
export interface PostingRulesView { items: PostingRuleRow[]; roles: { role: string; accepts: string; accountCodes: string[] }[]; accounts: { code: string; nameTh: string }[] }
export interface PostingPreviewRequest { docType: DocType; itemId?: string; expenseCategory?: string; partyId?: string }
export interface PostingPreviewResult { winners: { role: string; accountCode: string; accountName: string; rule: string; level: PostingLevel; key?: string }[]; journal: JournalPreview; missing: string[] }

/** The wire of the posting tab (ledger.posting.manage). A rule's id is `level|key|role`. */
export const postingApi = {
  rules: () => api<PostingRulesView>('GET', '/settings/posting/rules'),
  create: (body: Record<string, unknown>) => api<PostingRuleRow>('POST', '/settings/posting/rules', body),
  update: (id: string, body: { accountCode: string; version: number }) => api<PostingRuleRow>('PUT', `/settings/posting/rules/${encodeURIComponent(id)}`, body),
  remove: (id: string, version: number) => api<{ ok: true }>('DELETE', `/settings/posting/rules/${encodeURIComponent(id)}?version=${version}`),
  preview: (body: PostingPreviewRequest) => api<PostingPreviewResult>('POST', '/settings/posting/preview', body),
};

/** ST2 posting rules (SP0 §5.5): which account each accounting role posts to, by level. Metadata for the settings page (custom: tabs rules / categories / test); wire `/settings/posting/rules`. */
export const postingRule: RecordDescriptor = {
  kind: 'posting-rule', basePath: '/settings/posting', titleKey: 'records.postingRule.title', searchPlaceholderKey: 'records.postingRule.search',
  permissions: { read: 'ledger.posting.manage', manage: 'ledger.posting.manage' }, detail: false,
  columns: [{ key: 'level', labelKey: f('columns.level') }, { key: 'key', labelKey: f('columns.key') }, { key: 'role', labelKey: f('columns.role') }, { key: 'accountCode', labelKey: f('columns.account') }],
  fields: [
    { key: 'level', kind: 'select', labelKey: f('fields.level'), required: true, readOnlyAfterUse: true },
    { key: 'key', kind: 'text', labelKey: f('fields.key') },
    { key: 'role', kind: 'select', labelKey: f('fields.role'), required: true, readOnlyAfterUse: true },
    { key: 'accountCode', kind: 'account', labelKey: f('fields.account'), required: true },
  ],
};
