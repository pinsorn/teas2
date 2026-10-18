import type { Actor, StaffMember, UserRow } from '@/domain/types';
import { FieldErrors, imageError, refuseAgent } from '../engine/company';
import { MockError, logAudit, stamp } from '../engine/log';
import { isSystemRole, permissionsOf } from '../permissions';
import type { MockState } from '../store';
import { SYSTEM_ROLE_NAMES } from './roles';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const notFound = () => new MockError(404, 'record.not_found', 'ไม่พบผู้ใช้นี้');
/** A one-way fingerprint: all the state keeps of a link. The link itself is shown once and is not recoverable. */
const hash = (s: string): string => { let h = 0x811c9dc5; for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(16); };

const mine = (st: MockState, companyId: string, id: string): StaffMember => {
  const m = st.staff.find((x) => x.id === id && x.companyId === companyId);
  if (!m) throw notFound();
  return m;
};
const roleExists = (st: MockState, companyId: string, id: string) => isSystemRole(id) || st.roles.some((r) => r.id === id && r.companyId === companyId);
const roleName = (st: MockState, m: StaffMember) => (isSystemRole(m.roleId) ? SYSTEM_ROLE_NAMES[m.roleId] : st.roles.find((r) => r.id === m.roleId)?.name ?? m.roleId);
const holdsAdmin = (st: MockState, m: StaffMember) => permissionsOf(st, m.companyId, m.roleId).includes('users.manage');
const toRow = (st: MockState, m: StaffMember): UserRow => { const { linkHash: _h, userId: _u, ...rest } = m; void _h; void _u; return { ...rest, roleName: roleName(st, m) }; };
/** The trail keeps who and what, never a picture or a link. */
const shape = (m: StaffMember) => ({ name: m.name, email: m.email, roleId: m.roleId, position: m.position, hasSignature: !!m.signatureDataUrl, active: m.active });
const bump = (st: MockState, actor: Actor, m: StaffMember, command: string, before: ReturnType<typeof shape>) => { m.version += 1; logAudit(st, actor, m.companyId, command, m.id, before, shape(m)); };

/** ST1b m5 / ST2c N2: u-1's row follows the toolbar role while she holds a system role - a mapped COPY made where the row is read; the stored staff is never touched (no view objects in state). */
export const listUsers = (st: MockState, companyId: string, toolbarRole?: string): UserRow[] =>
  st.staff.filter((m) => m.companyId === companyId).map((m) => toRow(st, toolbarRole && m.userId === 'u-1' && isSystemRole(m.roleId) ? { ...m, roleId: toolbarRole } : m));

/** The last administrator of a company cannot be deactivated or moved to a role that cannot manage users; nor can a user do that to themselves (ruling 6, one code). */
function keepAnAdmin(st: MockState, actor: Actor, m: StaffMember, nextActive: boolean, nextRoleId: string): void {
  const stays = nextActive && permissionsOf(st, m.companyId, nextRoleId).includes('users.manage');
  if (!(m.active && !m.invitePending && holdsAdmin(st, m)) || stays) return;
  // a pending invite is not an administrator yet (its link may be lost or expired): only an accepted, active member counts (ST1a M1)
  const others = st.staff.some((x) => x.companyId === m.companyId && x.id !== m.id && x.active && !x.invitePending && holdsAdmin(st, x));
  if (!others) throw new MockError(409, 'user.last_admin', 'ผู้ดูแลระบบคนสุดท้ายของบริษัท ปิดใช้งานหรือลดสิทธิ์ไม่ได้ ทางออก: เพิ่มผู้ดูแลอีกคนก่อน');
  if (m.userId && m.userId === actor.id) throw new MockError(409, 'user.last_admin', 'ปิดใช้งานหรือลดสิทธิ์ตัวเองจากผู้ดูแลระบบไม่ได้ ให้ผู้ดูแลอีกคนทำให้');
}

type Values = { name?: unknown; email?: unknown; roleId?: unknown; position?: unknown; signatureDataUrl?: unknown; version?: unknown };
const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

export function inviteUser(st: MockState, actor: Actor, companyId: string, v: Values): { row: UserRow; link: string } {
  refuseAgent(actor);
  const e: Record<string, string[]> = {};
  if (!text(v.name)) e.name = ['ต้องระบุชื่อ'];
  const email = text(v.email).toLowerCase();
  if (!EMAIL.test(email)) e.email = ['อีเมลไม่ถูกต้อง'];
  else if (st.staff.some((m) => m.companyId === companyId && m.email.toLowerCase() === email)) e.email = ['อีเมลนี้เป็นสมาชิกของบริษัทอยู่แล้ว'];
  if (typeof v.roleId !== 'string' || !roleExists(st, companyId, v.roleId)) e.roleId = ['ต้องเลือกบทบาทของบริษัทนี้'];
  if (Object.keys(e).length) throw new FieldErrors(e);
  const token = crypto.randomUUID();
  const n = Math.max(0, ...st.staff.filter((m) => m.companyId === companyId).map((m) => Number(m.id.split('-').at(-1)) || 0)) + 1;
  const m: StaffMember = { id: `usr-${companyId.slice(3)}-${n}`, companyId, name: text(v.name), email, roleId: v.roleId as string, ...(text(v.position) ? { position: text(v.position) } : {}),
    active: true, version: 1, invitePending: true, linkHash: hash(token) };
  st.staff.push(m);
  logAudit(st, actor, companyId, 'user.invite', m.id, undefined, shape(m));
  return { row: toRow(st, m), link: `https://app.teas.example/invite/${token}` };
}

export function updateUser(st: MockState, actor: Actor, companyId: string, id: string, v: Values): UserRow {
  refuseAgent(actor);
  const m = mine(st, companyId, id);
  if (v.version !== m.version) throw new MockError(409, 'record.version_conflict', 'ข้อมูลนี้ถูกแก้ไขโดยผู้อื่นแล้ว โหลดข้อมูลใหม่ก่อนบันทึก');
  const e: Record<string, string[]> = {};
  if ('name' in v && !text(v.name)) e.name = ['ต้องระบุชื่อ'];
  if ('roleId' in v && (typeof v.roleId !== 'string' || !roleExists(st, companyId, v.roleId))) e.roleId = ['ต้องเลือกบทบาทของบริษัทนี้'];
  if (v.signatureDataUrl) { const msg = imageError(v.signatureDataUrl); if (msg) e.signatureDataUrl = [msg]; }
  if (Object.keys(e).length) throw new FieldErrors(e);
  if (typeof v.roleId === 'string' && v.roleId !== m.roleId) keepAnAdmin(st, actor, m, m.active, v.roleId);
  const before = shape(m);
  if ('name' in v) m.name = text(v.name);
  if (typeof v.roleId === 'string') m.roleId = v.roleId;
  if ('position' in v) { if (text(v.position)) m.position = text(v.position); else delete m.position; }
  if ('signatureDataUrl' in v) { if (v.signatureDataUrl) m.signatureDataUrl = v.signatureDataUrl as string; else delete m.signatureDataUrl; }
  bump(st, actor, m, 'user.update', before);
  return toRow(st, m);
}

export function setUserActive(st: MockState, actor: Actor, companyId: string, id: string, active: boolean, version: unknown): UserRow {
  refuseAgent(actor);
  const m = mine(st, companyId, id);
  if (version !== m.version) throw new MockError(409, 'record.version_conflict', 'ข้อมูลนี้ถูกแก้ไขโดยผู้อื่นแล้ว โหลดข้อมูลใหม่ก่อนบันทึก');
  if (m.active === active) return toRow(st, m);
  if (!active) keepAnAdmin(st, actor, m, false, m.roleId);
  const before = shape(m);
  m.active = active;
  bump(st, actor, m, active ? 'user.activate' : 'user.deactivate', before);
  return toRow(st, m);
}

/** A password-reset link: shown once, replaced by the next one, kept only as a hash. */
export function resetLink(st: MockState, actor: Actor, companyId: string, id: string): string {
  refuseAgent(actor);
  const m = mine(st, companyId, id);
  if (!m.active) throw new MockError(409, 'user.inactive', 'ผู้ใช้นี้ถูกปิดใช้งานอยู่ เปิดใช้งานก่อนจึงจะออกลิงก์ได้');
  const token = crypto.randomUUID();
  m.linkHash = hash(token);
  logAudit(st, actor, companyId, 'user.reset_link', m.id, undefined, { linkIssued: true });
  return `https://app.teas.example/reset/${token}`;
}

/** ST1a M1 "ยืนยันคำเชิญ": the mock's stand-in for the invited person following their link, so an invited administrator can become a real one. Audited like any change. */
export function acceptInvite(st: MockState, actor: Actor, companyId: string, id: string): UserRow {
  refuseAgent(actor);
  const m = mine(st, companyId, id);
  if (!m.invitePending) throw new MockError(409, 'user.not_pending', 'ผู้ใช้นี้รับคำเชิญแล้ว');
  const before = shape(m);
  m.invitePending = false; delete m.linkHash; m.lastLoginAt = stamp();
  bump(st, actor, m, 'user.accept_invite', before);
  return toRow(st, m);
}
