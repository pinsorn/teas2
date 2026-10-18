import type { RecordDescriptor } from '@/domain/records';

const f = (key: string) => `settings.users.${key}`;

/** ST1 users of a company (per-company memberships): metadata for the settings page. The page (`kit/settings/PeopleRoles.tsx`) is custom - invite / reset links, role change and the last-admin rule are commands, not a form - and its wire is `/settings/users` (handlers/settings.ts), so this descriptor is not in the generic `RECORDS` registry. */
export const user: RecordDescriptor = {
  kind: 'user', basePath: '/settings/users', titleKey: 'records.user.title', searchPlaceholderKey: 'records.user.search',
  permissions: { read: 'users.manage', manage: 'users.manage' }, detail: false,
  columns: [{ key: 'name', labelKey: f('columns.name') }, { key: 'email', labelKey: f('columns.email') }, { key: 'roleName', labelKey: f('columns.role') }, { key: 'position', labelKey: f('columns.position') }, { key: 'active', labelKey: f('columns.status'), kind: 'bool' }],
  fields: [
    { key: 'name', kind: 'text', labelKey: f('fields.name'), required: true },
    { key: 'email', kind: 'text', labelKey: f('fields.email'), required: true, readOnlyAfterUse: true },
    { key: 'roleId', kind: 'select', labelKey: f('fields.role'), required: true },
    { key: 'position', kind: 'text', labelKey: f('fields.position') },
  ],
};
