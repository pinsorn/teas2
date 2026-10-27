import { PERMISSIONS } from '@/domain/permissions';
import type { Actor, DocType, RoleRow } from '@/domain/types';
import { FieldErrors, refuseAgent } from '../engine/company';
import { MockError, logAudit } from '../engine/log';
import { PERMISSIONS_BY_ROLE, SYSTEM_ROLES, isSystemRole, permissionsOf } from '../permissions';
import type { MockState } from '../store';

/** The three system roles, read-only (code, not data); their names are the toolbar's. */
export const SYSTEM_ROLE_NAMES = { operator: 'พนักงานคีย์ข้อมูล', accountant: 'นักบัญชี', admin: 'ผู้ดูแลระบบ' } as const;

const notFound = () => new MockError(404, 'record.not_found', 'ไม่พบบทบาทนี้');
const approvalTypes = (st: MockState, companyId: string): DocType[] => st.approvalPolicies.filter((p) => p.companyId === companyId && p.enabled).map((p) => p.docType).sort();
const sodOf = (types: DocType[], perms: string[]): DocType[] => types.filter((t) => perms.includes(`doc.${t}.create`) && perms.includes(`doc.${t}.approve`));
const inUse = (st: MockState, companyId: string, id: string) => st.staff.some((m) => m.companyId === companyId && m.roleId === id);
const row = (st: MockState, companyId: string, id: string, name: string, perms: string[], system: boolean, version: number, description?: string): RoleRow => {
  const types = approvalTypes(st, companyId);
  return { id, version, active: true, system, name, ...(description ? { description } : {}), permissions: perms, inUse: inUse(st, companyId, id), approvalTypes: types, sodTypes: sodOf(types, perms) };
};

export const listRoles = (st: MockState, companyId: string): RoleRow[] => [
  ...SYSTEM_ROLES.map((r) => row(st, companyId, r, SYSTEM_ROLE_NAMES[r], PERMISSIONS_BY_ROLE[r], true, 1)),
  ...st.roles.filter((r) => r.companyId === companyId).map((r) => row(st, companyId, r.id, r.name, r.permissions, false, r.version, r.description)),
];

type Values = { name?: unknown; description?: unknown; permissions?: unknown };
function validate(st: MockState, companyId: string, v: Values, id?: string): { name: string; description?: string; permissions: string[] } {
  const e: Record<string, string[]> = {};
  const name = typeof v.name === 'string' ? v.name.trim() : '';
  if (!name) e.name = ['ต้องระบุชื่อบทบาท'];
  else if (Object.values(SYSTEM_ROLE_NAMES).includes(name as never) || st.roles.some((r) => r.companyId === companyId && r.name === name && r.id !== id)) e.name = ['ชื่อนี้ใช้แล้ว'];
  const perms = Array.isArray(v.permissions) ? v.permissions : [];
  if (!Array.isArray(v.permissions) || perms.some((p) => typeof p !== 'string' || !Object.hasOwn(PERMISSIONS, p))) e.permissions = ['มีรหัสสิทธิ์ที่ไม่อยู่ในรายการ'];
  if (Object.keys(e).length) throw new FieldErrors(e);
  const description = typeof v.description === 'string' && v.description.trim() ? v.description.trim() : undefined;
  return { name, ...(description ? { description } : {}), permissions: [...new Set(perms as string[])] };
}
const shape = (r: RoleRow | undefined) => r && { name: r.name, description: r.description, permissions: r.permissions };

/** A custom role (copying a system role is a create with its list). Agents are refused. */
export function createRole(st: MockState, actor: Actor, companyId: string, v: Values): RoleRow {
  refuseAgent(actor);
  const clean = validate(st, companyId, v);
  const n = Math.max(0, ...st.roles.map((r) => Number(r.id.split('-').at(-1)) || 0)) + 1;
  const r = { id: `role-${companyId.slice(3)}-${n}`, companyId, ...clean, version: 1 };
  st.roles.push(r);
  const out = row(st, companyId, r.id, r.name, r.permissions, false, 1, r.description);
  logAudit(st, actor, companyId, 'role.create', r.id, undefined, shape(out));
  return out;
}

export function updateRole(st: MockState, actor: Actor, companyId: string, id: string, v: Values & { version?: unknown }): RoleRow {
  refuseAgent(actor);
  if (isSystemRole(id)) throw new MockError(409, 'role.system_readonly', 'บทบาทของระบบแก้ไขไม่ได้ ใช้ “คัดลอกเป็นบทบาทใหม่”');
  const r = st.roles.find((x) => x.id === id && x.companyId === companyId);
  if (!r) throw notFound();
  if (v.version !== r.version) throw new MockError(409, 'record.version_conflict', 'ข้อมูลนี้ถูกแก้ไขโดยผู้อื่นแล้ว โหลดข้อมูลใหม่ก่อนบันทึก');
  const before = shape(listRoles(st, companyId).find((x) => x.id === id));
  const clean = validate(st, companyId, { name: v.name ?? r.name, description: 'description' in v ? v.description : r.description, permissions: v.permissions ?? r.permissions }, id);
  if (r.permissions.includes('users.manage') && !clean.permissions.includes('users.manage')) { // ST1a B1: taking users.manage off a role demotes everyone who holds it
    const real = (m: MockState['staff'][number]) => m.companyId === companyId && m.active && !m.invitePending;
    const holders = st.staff.filter((m) => real(m) && m.roleId === id);
    if (holders.length && !st.staff.some((m) => real(m) && m.roleId !== id && permissionsOf(st, companyId, m.roleId).includes('users.manage'))) throw new MockError(409, 'user.last_admin', 'ผู้ดูแลระบบคนสุดท้ายของบริษัท ถอนสิทธิ์จัดการผู้ใช้ไม่ได้ ทางออก: เพิ่มผู้ดูแลอีกคนก่อน');
    if (holders.some((m) => m.userId && m.userId === actor.id)) throw new MockError(409, 'user.last_admin', 'ถอนสิทธิ์จัดการผู้ใช้ของบทบาทที่ตัวเองใช้อยู่ไม่ได้ ให้ผู้ดูแลอีกคนทำให้');
  }
  r.name = clean.name; r.permissions = clean.permissions; r.version += 1;
  if (clean.description) r.description = clean.description; else delete r.description;
  const out = listRoles(st, companyId).find((x) => x.id === id)!;
  logAudit(st, actor, companyId, 'role.update', id, before, shape(out));
  return out;
}

export function deleteRole(st: MockState, actor: Actor, companyId: string, id: string, version?: number): void {
  refuseAgent(actor);
  if (isSystemRole(id)) throw new MockError(409, 'role.system_readonly', 'บทบาทของระบบลบไม่ได้');
  const r = st.roles.find((x) => x.id === id && x.companyId === companyId);
  if (!r) throw notFound();
  if (version !== undefined && version !== r.version) throw new MockError(409, 'record.version_conflict', 'ข้อมูลนี้ถูกแก้ไขโดยผู้อื่นแล้ว โหลดข้อมูลใหม่ก่อนลบ'); // route 29: ?version= is required by the route (the handler always passes it)
  if (inUse(st, companyId, id)) throw new MockError(409, 'role.in_use', `ลบบทบาท ${r.name} ไม่ได้ เพราะมีผู้ใช้ใช้อยู่ เปลี่ยนบทบาทของผู้ใช้ก่อน`);
  const before = shape(listRoles(st, companyId).find((x) => x.id === id));
  st.roles = st.roles.filter((x) => x !== r);
  logAudit(st, actor, companyId, 'role.delete', id, before, undefined);
}

