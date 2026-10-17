import type { RecordDescriptor } from '@/domain/records';

const f = (key: string) => `records.fields.${key}`;

/** AC4 recurring templates and prepaid / deferred amortisation schedules. Created from a document ("ตั้งเป็นรายการซ้ำ" / "ตั้งตัดจ่าย"), never from a blank form (`noCreate`); the detail is a custom static page (`/accounting/schedules/[id]`). */
export const schedule: RecordDescriptor = {
  kind: 'schedule', basePath: '/accounting/schedules', titleKey: 'records.schedule.title', searchPlaceholderKey: 'records.schedule.search',
  permissions: { read: 'ledger.read', manage: 'ledger.schedule.manage' }, detail: true, noCreate: true,
  columns: [
    { key: 'name', labelKey: f('scheduleName') }, { key: 'kind', labelKey: f('scheduleKind'), optionKey: 'scheduleKind' }, { key: 'frequency', labelKey: f('scheduleFrequency'), optionKey: 'scheduleFrequency' },
    { key: 'nextRun', labelKey: f('nextRun'), kind: 'date' }, { key: 'total', labelKey: f('scheduleTotal'), kind: 'money', align: 'end' }, { key: 'active', labelKey: f('active'), kind: 'bool' },
  ],
  fields: [{ key: 'name', kind: 'text', labelKey: f('scheduleName'), required: true }],
};
