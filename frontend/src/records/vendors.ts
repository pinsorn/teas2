import type { RecordDescriptor } from '@/domain/records';
import { partyColumns, partyFields } from './customers';

const f = (key: string) => `records.fields.${key}`;

export const vendor: RecordDescriptor = {
  kind: 'vendor', basePath: '/master/vendors', titleKey: 'records.vendor.title', searchPlaceholderKey: 'records.vendor.search',
  permissions: { read: 'party.read', manage: 'party.manage' }, columns: partyColumns, detail: true,
  fields: [
    ...partyFields.slice(0, -1),
    { key: 'vatDRegistered', kind: 'bool', labelKey: f('vatDRegistered'), showWhen: { key: 'entityKind', equals: 'foreign' } },
    { key: 'bankName', kind: 'text', labelKey: f('bankName') },
    { key: 'bankAccountNo', kind: 'text', labelKey: f('bankAccountNo') },
    { key: 'bankAccountName', kind: 'text', labelKey: f('bankAccountName') },
    { key: 'usualItemIds', kind: 'item', itemUsage: 'purchase', labelKey: f('usualItemIds'), multiple: true },
    partyFields[partyFields.length - 1],
  ],
};
