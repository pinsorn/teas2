import type { LinkInfo } from '@/contract/platform';
import type { Actor, StaffMember, UserRow } from '@/domain/types';
import { FieldErrors, imageError, refuseAgent } from '../engine/company';
import { MockError, logAudit, stamp } from '../engine/log';
import { isSystemRole, permissionsOf } from '../permissions';
import type { MockState } from '../store';
import { hashOf } from './connect';
import { SYSTEM_ROLE_NAMES } from './roles';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const notFound = () => new MockError(404, 'record.not_found', 'ไม่พบผู้ใช้นี้');
/** A one-way fingerprint: all the state keeps of a link. The link itself is shown once and is not recoverable. */
const hash = (s: string): string => { let h = 0x811c9dc5; for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(16); };

/** P0e: who issued a reset link (stored at issue; internal, never on the wire) so the whole-account check can be re-run when the link is USED. */
type Linked = StaffMember & { linkIssuer?: string };
const mine = (st: MockState, companyId: string, id: string): StaffMember => {
  const m = st.staff.find((x) => x.id === id && x.companyId === companyId);
  if (!m) throw notFound();
  return m;
};
const roleExists = (st: MockState, companyId: string, id: string) => isSystemRole(id) || st.roles.some((r) => r.id === id && r.companyId === companyId);
const roleName = (st: MockState, m: StaffMember) => (isSystemRole(m.roleId) ? SYSTEM_ROLE_NAMES[m.roleId] : st.roles.find((r) => r.id === m.roleId)?.name ?? m.roleId);
const holdsAdmin = (st: MockState, m: StaffMember) => permissionsOf(st, m.companyId, m.roleId).includes('users.manage');
const toRow = (st: MockState, m: StaffMember): UserRow => { const { linkHash: _h, linkKind: _k, linkExpiresAt: _e, linkIssuer: _i, userId: _u, ...rest } = m as Linked; void _h; void _k; void _e; void _i; void _u; return { ...rest, roleName: roleName(st, m) }; };
/** The trail keeps who and what, never a picture or a link. */
const shape = (m: StaffMember) => ({ name: m.name, email: m.email, roleId: m.roleId, position: m.position, hasSignature: !!m.signatureDataUrl, active: m.active });
const bump = (st: MockState, actor: Actor, m: StaffMember, command: string, before: ReturnType<typeof shape>) => { m.version += 1; logAudit(st, actor, m.companyId, command, m.id, before, shape(m)); };

/** The row as shown: u-1 follows the toolbar role while she holds a system role (a COPY; the stored member is never touched). */
const shown = (st: MockState, m: StaffMember, toolbarRole?: string): UserRow => toRow(st, toolbarRole && m.userId === 'u-1' && isSystemRole(m.roleId) ? { ...m, roleId: toolbarRole } : m);
/** ST1b m5 / ST2c N2: u-1's row follows the toolbar role while she holds a system role - a mapped COPY made where the row is read; the stored staff is never touched (no view objects in state). */
export const listUsers = (st: MockState, companyId: string, toolbarRole?: string): UserRow[] =>
  st.staff.filter((m) => m.companyId === companyId).map((m) => shown(st, m, toolbarRole));

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
    active: true, version: 1, invitePending: true };
  issue(m, 'invite', token);
  st.staff.push(m);
  logAudit(st, actor, companyId, 'user.invite', m.id, undefined, shape(m));
  return { row: toRow(st, m), link: `https://app.teas.example/link/${token}` };
}

export function updateUser(st: MockState, actor: Actor, companyId: string, id: string, v: Values, toolbarRole?: string): UserRow {
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
  return shown(st, m, toolbarRole);
}

export function setUserActive(st: MockState, actor: Actor, companyId: string, id: string, active: boolean, version: unknown, toolbarRole?: string): UserRow {
  refuseAgent(actor);
  const m = mine(st, companyId, id);
  if (version !== m.version) throw new MockError(409, 'record.version_conflict', 'ข้อมูลนี้ถูกแก้ไขโดยผู้อื่นแล้ว โหลดข้อมูลใหม่ก่อนบันทึก');
  if (m.active === active) return shown(st, m, toolbarRole);
  if (!active) keepAnAdmin(st, actor, m, false, m.roleId);
  const before = shape(m);
  m.active = active;
  if (!active) clearLink(m); // a deactivated member's link ends with the membership
  bump(st, actor, m, active ? 'user.activate' : 'user.deactivate', before);
  return shown(st, m, toolbarRole);
}

/** P0c: a member's account is found by the member's `userId` (the fixtures' un-accepted rows use their own id as the account id), NEVER by the membership email: an email never creates a second login for an existing user. */
const accountOf = (st: MockState, m: StaffMember) => st.auth?.creds.find((c) => c.userId === (m.userId ?? m.id));
/** P0c: reset-link and totp-reset take over a whole ACCOUNT, so the issuer must hold users.manage in EVERY company where the target has an active or pending membership; else 403 user.cross_company (exit: the server operator's CLI). */
function crossCompany(st: MockState, actor: Actor, m: StaffMember): void {
  const a = accountOf(st, m), acct = a?.userId ?? m.userId;
  // P0d: EVERY other membership of the account counts, whatever its state (active, deactivated, pending): it is the account's by userId, or a pending invite of the login email, or (extra key) it carries this membership's email
  const others = st.staff.filter((x) => x.companyId !== m.companyId && ((acct !== undefined && (x.userId ?? x.id) === acct) || (x.invitePending && !!a && x.email.toLowerCase() === a.email.toLowerCase()) || x.email.toLowerCase() === m.email.toLowerCase()));
  for (const x of others) {
    const mine = st.staff.find((y) => y.companyId === x.companyId && y.userId === actor.id && y.active && !y.invitePending);
    if (!mine || !permissionsOf(st, x.companyId, mine.roleId).includes('users.manage')) throw new MockError(403, 'user.cross_company', 'ผู้ใช้นี้เป็นสมาชิกบริษัทอื่นด้วย ทางออก: ให้ผู้ดูแลเซิร์ฟเวอร์รีเซ็ตด้วยคำสั่ง reset-password / reset-mfa หลังยืนยันตัวตน');
  }
}

/** A password-reset link: shown once, replaced by the next one, kept only as a hash. */
export function resetLink(st: MockState, actor: Actor, companyId: string, id: string): string {
  refuseAgent(actor);
  const m = mine(st, companyId, id);
  crossCompany(st, actor, m);
  if (!m.active) throw new MockError(409, 'user.inactive', 'ผู้ใช้นี้ถูกปิดใช้งานอยู่ เปิดใช้งานก่อนจึงจะออกลิงก์ได้');
  if (m.invitePending) throw new MockError(409, 'user.invite_pending', 'ผู้ใช้นี้ยังไม่ได้รับคำเชิญ ใช้ลิงก์เชิญที่ออกไว้ (ออกคำเชิญใหม่ได้ทางการแก้ไข)');
  const token = crypto.randomUUID();
  issue(m, 'reset', token, actor.id);
  logAudit(st, actor, companyId, 'user.reset_link', m.id, undefined, { linkIssued: true });
  return `https://app.teas.example/link/${token}`;
}

/** ST1a M1 "ยืนยันคำเชิญ": the mock's stand-in for the invited person following their link, so an invited administrator can become a real one. Audited like any change. */
export function acceptInvite(st: MockState, actor: Actor, companyId: string, id: string): UserRow {
  refuseAgent(actor);
  const m = mine(st, companyId, id);
  if (!m.invitePending) throw new MockError(409, 'user.not_pending', 'ผู้ใช้นี้รับคำเชิญแล้ว');
  const before = shape(m);
  m.invitePending = false; clearLink(m); m.lastLoginAt = stamp();
  bump(st, actor, m, 'user.accept_invite', before);
  return toRow(st, m);
}

// ---- SP3 P0 / P0a (Q4): the invite / reset link page. A link is single use and ends at an expiry stored at issue; unknown, used, expired, superseded and
// "of an inactive member" are ONE answer (404 auth.link_invalid). An invite of an EXISTING account (a user with a password) sets no password: only that
// signed-in user can accept it. ----
export const LINK_INVALID = 'ลิงก์นี้ใช้ไม่ได้แล้วหรือหมดอายุ ขอลิงก์ใหม่จากผู้ดูแลระบบ';
const linkGone = () => new MockError(404, 'auth.link_invalid', LINK_INVALID);
/** Fixed tokens for the screenshot / e2e review (reusable: they spend nothing). */
export const FIXTURE_LINKS: Record<string, LinkInfo> = {
  'inv-5c1e8a3f7b2d4690': { kind: 'invite', email: 'newcomer@maliwan.example', companyName: 'บริษัท มะลิวัลย์ เทรดดิ้ง จำกัด', expiresAt: '2026-12-31T09:00:00.000Z', existingAccount: false },
  'inv-8b2e4d6f1a3c7095': { kind: 'invite', email: 'somsri@maliwan.example', companyName: 'บริษัท บ้านต้นข้าว จำกัด', expiresAt: '2026-12-31T09:00:00.000Z', existingAccount: true },
  'rst-9d4b2f6a1c7e3850': { kind: 'reset', email: 'wichai@maliwan.example', expiresAt: '2026-12-31T09:00:00.000Z', existingAccount: false },
};
const LINK_TTL = { invite: 7 * 86_400_000, reset: 24 * 3_600_000 };
const now = () => Date.parse(stamp());
/** Stores what the member's one live link is for and when it ends (a newer link replaces the older). */
const issue = (m: StaffMember, kind: 'invite' | 'reset', token: string, issuer?: string) => { (m as Linked).linkIssuer = issuer; m.linkHash = hash(token); m.linkKind = kind; m.linkExpiresAt = new Date(now() + LINK_TTL[kind]).toISOString(); };
const clearLink = (m: StaffMember) => { delete (m as Linked).linkIssuer; delete m.linkHash; delete m.linkKind; delete m.linkExpiresAt; };
/** The member a LIVE link belongs to: active, with an unexpired link of a kind that still makes sense. */
const holder = (st: MockState, token: string): StaffMember | undefined => {
  const m = st.staff.find((x) => x.linkHash === hash(token));
  if (!(m && m.active && m.linkKind && m.linkExpiresAt && Date.parse(m.linkExpiresAt) > now() && (m.linkKind === 'invite') === m.invitePending)) return undefined;
  const issuer = (m as Linked).linkIssuer; // P0e: checked at issue AND at use: the account may have gained a membership the issuer does not manage since
  if (m.linkKind === 'reset' && issuer) { try { crossCompany(st, { kind: 'user', id: issuer, name: '' }, m); } catch { return undefined; } }
  return m;
};
/** P0b: an existing user = a user row for the email, whatever its password state; an INVITE never sets a password for one. */
const credOfEmail = (st: MockState, email: string) => st.auth?.creds.find((c) => c.email.toLowerCase() === email.toLowerCase());
export function linkInfo(st: MockState, token: string): LinkInfo {
  if (Object.hasOwn(FIXTURE_LINKS, token)) return FIXTURE_LINKS[token];
  const m = holder(st, token);
  if (!m) throw linkGone();
  const company = st.companies.find((c) => c.id === m.companyId);
  return { kind: m.linkKind!, email: m.email, ...(m.linkKind === 'invite' && company ? { companyName: company.legalNameTh } : {}), expiresAt: m.linkExpiresAt!, existingAccount: m.linkKind === 'invite' && !!credOfEmail(st, m.email) };
}
const STRENGTH = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{10,}$/; // the same rule as a password change (SP3 4.4)
/** `session` = the user the browser is signed in as right now (a live session), else undefined. */
export function consumeLink(st: MockState, token: string, v: { password?: unknown; confirm?: unknown }, session?: { userId: string }): void {
  const info = linkInfo(st, token);
  const m = holder(st, token);
  if (info.existingAccount) { // accept only from a signed-in session of THAT user; a password in the body is never read
    const c = credOfEmail(st, info.email);
    if (!m || !c || session?.userId !== c.userId) throw linkGone(); // fixtures (no member) and everyone else: the one answer
    const before = shape(m);
    clearLink(m); m.invitePending = false; m.userId ??= c.userId; m.lastLoginAt = stamp();
    bump(st, { kind: 'user', id: c.userId, name: m.name }, m, 'user.accept_invite', before);
    return;
  }
  if (v.password !== v.confirm) throw new MockError(422, 'auth.password_mismatch', 'รหัสผ่านและการยืนยันไม่ตรงกัน');
  if (typeof v.password !== 'string' || !STRENGTH.test(v.password)) throw new MockError(422, 'auth.password_weak', 'รหัสผ่านต้องยาวอย่างน้อย 10 ตัวอักษร และมีตัวพิมพ์เล็ก ตัวพิมพ์ใหญ่ และตัวเลข');
  if (!m) return; // a fixture token: nothing to change
  const a = (st.auth ??= { creds: [], sessions: [], current: '', failures: {}, challenges: {} });
  let c = accountOf(st, m);
  if (!c) a.creds.push((c = { userId: m.userId ?? m.id, email: m.email, displayName: m.name, passwordHash: '', recovery: [] }));
  c.passwordHash = hashOf(v.password);
  delete a.failures[hashOf(m.email.trim().toLowerCase())]; // a new password clears the lockout counter
  const actor: Actor = { kind: 'user', id: c.userId, name: m.name };
  const before = shape(m);
  clearLink(m);
  if (info.kind === 'invite') { m.invitePending = false; m.userId ??= c.userId; m.lastLoginAt = stamp(); bump(st, actor, m, 'user.accept_invite', before); }
  else { for (const s of a.sessions) if (s.userId === c.userId && !s.revokedAt) s.revokedAt = stamp(); logAudit(st, actor, m.companyId, 'auth.password.reset', m.id); } // a reset ends every session of that user
}

/** Q3: an administrator clears another member's second factor and recovery codes (their sessions end); never on yourself. */
export function resetTotp(st: MockState, actor: Actor, companyId: string, id: string, version: unknown, selfUserId: string): UserRow {
  refuseAgent(actor);
  const m = mine(st, companyId, id);
  if (m.userId === selfUserId) throw new MockError(403, 'auth.forbidden', 'รีเซ็ตการยืนยันตัวตนสองขั้นของตัวเองไม่ได้ ให้ผู้ดูแลระบบคนอื่นทำให้');
  crossCompany(st, actor, m);
  if (version !== m.version) throw new MockError(409, 'record.version_conflict', 'ข้อมูลนี้ถูกแก้ไขโดยผู้อื่นแล้ว โหลดข้อมูลใหม่ก่อนบันทึก');
  const c = accountOf(st, m);
  if (c) {
    delete c.secretHash; delete c.pendingSecretHash; c.recovery = [];
    for (const s of st.auth!.sessions) if (s.userId === c.userId && !s.revokedAt) s.revokedAt = stamp();
  }
  bump(st, actor, m, 'user.totp_reset', shape(m));
  return toRow(st, m);
}
