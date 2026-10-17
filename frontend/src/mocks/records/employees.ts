import type { RecordRow } from '@/domain/records';
import { isValidTin } from '@/domain/tin';
import { MockError } from '../engine/log';
import type { MockState } from '../store';
import type { RecordKindImpl } from './registry';

type Party = MockState['parties'][number];
type Pay = NonNullable<Party['payroll']>;

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const isDate = (s: string | undefined) => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
const isMoney = (v: unknown) => typeof v === 'string' && /^\d+(\.\d{1,2})?$/.test(v.trim());
const mine = (st: MockState, companyId: string) => st.parties.filter((p) => p.companyId === companyId && p.kind === 'employee');
/** An employee on any payroll run - any slip a run took, and any row of a draft - or on any other document (an expense claim): their history needs them. Deactivate instead of deleting. */
const used = (st: MockState, p: Party) => st.docs.some((d) => d.companyId === p.companyId && (d.header.partyId === p.id || (d.type === 'PR' && (d.lines.some((l) => l.employeeId === p.id) || !!d.payroll?.slips.some((s) => s.employeeId === p.id)))));
const nameOf = (v: Record<string, unknown>) => `${str(v.titleName) ?? ''}${str(v.firstName)} ${str(v.lastName)}`.trim();

function toRow(st: MockState, p: Party): RecordRow {
  const x = p.payroll;
  return {
    id: p.id, version: p.version ?? 1, active: p.active !== false, inUse: used(st, p), code: p.code, name: p.name, titleName: x?.titleName, firstName: x?.firstName, lastName: x?.lastName,
    nationalId: p.taxId, taxId: p.taxId, startDate: x?.startDate, endDate: x?.endDate, salary: x?.salary, bankName: p.bankAccount?.bankName, bankAccountNo: p.bankAccount?.accountNo,
    ssoRegistered: x?.ssoRegistered ?? false, maritalStatus: x?.maritalStatus ?? 'single', spouseHasIncome: x?.spouseHasIncome ?? false, children: x?.children ?? 0, otherAllowances: x?.otherAllowances ?? '0.00',
  };
}

/** The values a form sends -> the stored party. Fields the form does not edit are kept; an absent optional field is cleared. */
function apply(prev: Party | undefined, base: Pick<Party, 'id' | 'companyId'>, v: Record<string, unknown>): Party {
  const name = nameOf(v), bank = { bankName: str(v.bankName), accountNo: str(v.bankAccountNo), accountName: name };
  const married = v.maritalStatus === 'married';
  const payroll: Pay = {
    ...(str(v.titleName) ? { titleName: str(v.titleName)! } : {}), firstName: str(v.firstName)!, lastName: str(v.lastName)!, startDate: str(v.startDate)!, ...(str(v.endDate) ? { endDate: str(v.endDate)! } : {}),
    salary: Number(str(v.salary)).toFixed(2), ssoRegistered: v.ssoRegistered === true, maritalStatus: married ? 'married' : 'single', spouseHasIncome: married && v.spouseHasIncome === true,
    children: Number(v.children ?? 0), otherAllowances: str(v.otherAllowances) ? Number(str(v.otherAllowances)).toFixed(2) : '0.00',
  };
  const next: Party = {
    ...prev, ...base, kind: 'employee', entityKind: 'individual', vatRegistered: false, paymentTermDays: 0, partyGroup: 'general', code: str(v.code)!, name, taxId: str(v.nationalId)!,
    bankAccount: bank.bankName || bank.accountNo ? bank : undefined, payroll, version: prev ? (prev.version ?? 1) + 1 : 1,
  };
  return JSON.parse(JSON.stringify(next)) as Party;
}

/** Like every record kind, plus `remove`: an employee on any payroll run is deactivated, never deleted (the wire route is in handlers/docs-write.ts). */
export const employeeImpl: RecordKindImpl & { remove: (st: MockState, companyId: string, id: string) => void } = {
  perms: { read: 'employee.read', manage: 'employee.manage' },
  rows: (st, companyId) => mine(st, companyId).map((p) => toRow(st, p)),

  validate(v, st, companyId, id) {
    const e: Record<string, string[]> = {};
    const add = (k: string, m: string) => { (e[k] ??= []).push(m); };
    const prev = id ? mine(st, companyId).find((p) => p.id === id) : undefined;
    const code = str(v.code);
    if (!code) add('code', 'ต้องระบุรหัสพนักงาน');
    else if (mine(st, companyId).some((p) => p.code === code && p.id !== id)) add('code', 'รหัสนี้ใช้แล้ว');
    else if (prev && code !== prev.code && used(st, prev)) add('code', 'รหัสแก้ไม่ได้หลังจากใช้ในเอกสารแล้ว');
    if (!str(v.firstName)) add('firstName', 'ต้องระบุชื่อ');
    if (!str(v.lastName)) add('lastName', 'ต้องระบุนามสกุล');
    const nid = str(v.nationalId);
    if (!nid) add('nationalId', 'ต้องระบุเลขบัตรประจำตัวประชาชน');
    else if (!isValidTin(nid)) add('nationalId', 'เลขบัตรประจำตัวประชาชนไม่ถูกต้อง (13 หลัก ตรวจสอบหลักสุดท้าย)');
    else if (mine(st, companyId).some((p) => p.taxId === nid && p.id !== id)) add('nationalId', 'เลขบัตรประจำตัวประชาชนนี้มีพนักงานอีกคนใช้แล้ว');
    const start = str(v.startDate), end = str(v.endDate);
    if (!isDate(start)) add('startDate', 'ต้องระบุวันที่เริ่มงาน');
    if (end && !isDate(end)) add('endDate', 'วันที่ลาออกไม่ถูกต้อง');
    else if (end && start && isDate(start) && end < start) add('endDate', 'วันที่ลาออกต้องไม่ก่อนวันที่เริ่มงาน');
    if (!isMoney(v.salary)) add('salary', 'ต้องระบุเงินเดือน (ตัวเลข ไม่เกิน 2 ตำแหน่งทศนิยม)');
    if (str(v.otherAllowances) && !isMoney(v.otherAllowances)) add('otherAllowances', 'จำนวนเงินไม่ถูกต้อง');
    if (v.maritalStatus !== 'single' && v.maritalStatus !== 'married') add('maritalStatus', 'ต้องเลือกสถานภาพ');
    if (v.children !== undefined && !(Number.isInteger(v.children) && (v.children as number) >= 0)) add('children', 'ต้องเป็นจำนวนเต็มไม่น้อยกว่า 0');
    return e;
  },

  create(st, companyId, v) {
    const stem = st.companies.find((c) => c.id === companyId)!.vatRegistered ? 'emp' : 'nemp';
    const n = Math.max(0, ...st.parties.filter((p) => p.id.startsWith(`${stem}-`)).map((p) => Number(p.id.slice(stem.length + 1)) || 0)) + 1;
    const p = apply(undefined, { id: `${stem}-${String(n).padStart(2, '0')}`, companyId }, v);
    st.parties.push(p);
    return toRow(st, p);
  },

  update(st, companyId, id, v) {
    const prev = mine(st, companyId).find((p) => p.id === id);
    if (!prev) throw new MockError(404, 'record.not_found', 'ไม่พบข้อมูลนี้');
    const next = apply(prev, { id, companyId }, v);
    Object.assign(prev, next);
    for (const k of Object.keys(prev) as (keyof Party)[]) if (!(k in next)) delete prev[k]; // a cleared field is gone, not stale
    return toRow(st, prev); // issued payslips are not touched: they froze the employee as they were
  },

  setActive(st, companyId, id, active) {
    const p = mine(st, companyId).find((x) => x.id === id);
    if (!p) throw new MockError(404, 'record.not_found', 'ไม่พบข้อมูลนี้');
    p.active = active;
    p.version = (p.version ?? 1) + 1;
    return toRow(st, p);
  },

  remove(st, companyId, id) {
    const p = mine(st, companyId).find((x) => x.id === id);
    if (!p) throw new MockError(404, 'record.not_found', 'ไม่พบข้อมูลนี้');
    if (used(st, p)) throw new MockError(409, 'employee.in_use', `ลบพนักงาน ${p.name} ไม่ได้ เพราะมีรอบเงินเดือนหรือเอกสารอ้างถึงอยู่ ปิดใช้งานแทน`);
    st.parties = st.parties.filter((x) => x !== p);
  },
};
