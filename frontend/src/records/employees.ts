import type { RecordDescriptor } from '@/domain/records';

const f = (key: string) => `records.fields.${key}`;
const opt = (group: string, values: string[]) => values.map((value) => ({ value, labelKey: `records.options.${group}.${value}` }));

/** PY1 employee master (payroll). The national ID is a 13-digit number with the TIN checksum, unique in the company; an employee on any payroll run is deactivated, never deleted. Everything a payslip uses is frozen on the slip when its run is issued,
 *  so editing an employee changes only runs not yet issued. The amounts of tax and social security are computed by the server (`[SP-R]` tables), never typed here. */
export const employee: RecordDescriptor = {
  kind: 'employee', basePath: '/payroll/employees', titleKey: 'records.employee.title', searchPlaceholderKey: 'records.employee.search',
  permissions: { read: 'employee.read', manage: 'employee.manage' }, detail: true,
  columns: [
    { key: 'code', labelKey: f('code') }, { key: 'name', labelKey: f('name') }, { key: 'nationalId', labelKey: f('nationalId') }, { key: 'startDate', labelKey: f('startDate'), kind: 'date' },
    { key: 'salary', labelKey: f('salary'), kind: 'money', align: 'end' }, { key: 'ssoRegistered', labelKey: f('ssoRegistered'), kind: 'bool' }, { key: 'active', labelKey: f('active'), kind: 'bool' },
  ],
  fields: [
    { key: 'code', kind: 'text', labelKey: f('code'), required: true, readOnlyAfterUse: true },
    { key: 'titleName', kind: 'text', labelKey: f('titleName') },
    { key: 'firstName', kind: 'text', labelKey: f('firstName'), required: true },
    { key: 'lastName', kind: 'text', labelKey: f('lastName'), required: true },
    { key: 'nationalId', kind: 'tin', labelKey: f('nationalId'), required: true },
    { key: 'startDate', kind: 'date', labelKey: f('startDate'), required: true },
    { key: 'endDate', kind: 'date', labelKey: f('endDate') },
    { key: 'salary', kind: 'money', labelKey: f('salary'), required: true },
    { key: 'bankName', kind: 'text', labelKey: f('bankName') },
    { key: 'bankAccountNo', kind: 'text', labelKey: f('bankAccountNo') },
    { key: 'ssoRegistered', kind: 'bool', labelKey: f('ssoRegistered'), defaultValue: true },
    { key: 'maritalStatus', kind: 'select', labelKey: f('maritalStatus'), required: true, defaultValue: 'single', options: opt('maritalStatus', ['single', 'married']) },
    { key: 'spouseHasIncome', kind: 'bool', labelKey: f('spouseHasIncome'), showWhen: { key: 'maritalStatus', equals: 'married' } },
    { key: 'children', kind: 'int', labelKey: f('children'), defaultValue: '0' },
    { key: 'otherAllowances', kind: 'money', labelKey: f('otherAllowances'), defaultValue: '0.00' },
  ],
};
