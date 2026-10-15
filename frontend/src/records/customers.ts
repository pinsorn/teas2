import type { FieldSpec, RecordColumn, RecordDescriptor } from '@/domain/records';

const f = (key: string) => `records.fields.${key}`;
const opt = (group: string, values: string[]) => values.map((value) => ({ value, labelKey: `records.options.${group}.${value}` }));

/** Values of `partyGroup` (the mock `party-groups` fixture); the labels are messages. */
export const PARTY_GROUPS = ['general', 'major', 'government', 'foreign'];

/** Shared by customers and vendors: one party shape, the kind only adds fields. `notes` is last (vendors insert theirs before it). */
export const partyFields: FieldSpec[] = [
  { key: 'entityKind', kind: 'select', labelKey: f('entityKind'), required: true, options: opt('entityKind', ['individual', 'juristic', 'foreign']) },
  { key: 'code', kind: 'text', labelKey: f('code'), required: true, readOnlyAfterUse: true },
  { key: 'name', kind: 'text', labelKey: f('name'), required: true },
  { key: 'nameEn', kind: 'text', labelKey: f('nameEn') },
  { key: 'taxId', kind: 'tin', labelKey: f('taxId'), requiredWhen: [{ key: 'vatRegistered', equals: true }, { key: 'entityKind', equals: 'juristic' }] },
  { key: 'branchCode', kind: 'branch', labelKey: f('branchCode'), defaultValue: '00000' },
  { key: 'vatRegistered', kind: 'bool', labelKey: f('vatRegistered') },
  { key: 'address', kind: 'textarea', labelKey: f('address'), requiredWhen: [{ key: 'vatRegistered', equals: true }] },
  { key: 'phone', kind: 'text', labelKey: f('phone') },
  { key: 'email', kind: 'text', labelKey: f('email') },
  { key: 'paymentTermDays', kind: 'int', labelKey: f('paymentTermDays') },
  { key: 'partyGroup', kind: 'select', labelKey: f('partyGroup'), options: opt('partyGroup', PARTY_GROUPS) },
  { key: 'defaultWhtTypeCode', kind: 'select', labelKey: f('defaultWhtTypeCode'), optionsFrom: 'wht-types' },
  { key: 'notes', kind: 'textarea', labelKey: f('notes') },
];
export const partyColumns: RecordColumn[] = [
  { key: 'code', labelKey: f('code') }, { key: 'name', labelKey: f('name') }, { key: 'taxId', labelKey: f('taxId') },
  { key: 'branchCode', labelKey: f('branchCode') }, { key: 'vatRegistered', labelKey: f('vatRegistered'), kind: 'bool' },
  { key: 'paymentTermDays', labelKey: f('paymentTermDays'), align: 'end' }, { key: 'active', labelKey: f('active'), kind: 'bool' },
];

export const customer: RecordDescriptor = {
  kind: 'customer', basePath: '/master/customers', titleKey: 'records.customer.title', searchPlaceholderKey: 'records.customer.search',
  permissions: { read: 'party.read', manage: 'party.manage' }, columns: partyColumns, fields: partyFields, detail: true,
};
