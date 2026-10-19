import type { RecordDescriptor } from '@/domain/records';

const f = (key: string) => `settings.roles.${key}`;

/** ST1 roles of a company: three read-only system roles plus custom ones (name, description, the permission matrix). Metadata for the settings page (custom, like users); wire `/settings/roles`. */
export const role: RecordDescriptor = {
  kind: 'role', basePath: '/settings/roles', titleKey: 'records.role.title', searchPlaceholderKey: 'records.role.search',
  permissions: { read: 'users.manage', manage: 'users.manage' }, detail: false,
  columns: [{ key: 'name', labelKey: f('columns.name') }, { key: 'description', labelKey: f('columns.description') }, { key: 'permissions', labelKey: f('columns.permissions') }, { key: 'inUse', labelKey: f('columns.users'), kind: 'bool' }],
  fields: [
    { key: 'name', kind: 'text', labelKey: f('fields.name'), required: true },
    { key: 'description', kind: 'textarea', labelKey: f('fields.description') },
  ],
};
