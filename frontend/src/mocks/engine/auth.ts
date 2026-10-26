import { DOC_TYPES, LIVE } from '@/domain/doc-types';
import type { Actor, Company, Role } from '@/domain/types';
import type { MockState } from '../store';
import { chartOfAccounts } from '../fixtures/coa';
import { DEFAULT_NOTES } from '../fixtures/default-notes';
import { FIXTURE_PREDICATES } from '../fixtures/ids';
import { postingRulesFor } from '../fixtures/posting-profiles';
import { whtTypesFor } from '../fixtures/wht-types';
import { bankAccountImpl } from '../records/bank-accounts';
import { hashOf } from '../records/connect';
import { FieldErrors, refuseAgent, updateCompany } from './company';
import { MockError, logAudit, stamp, withFixedClock } from './log';
import { firstOpenMonthStart } from './opening';
import { PRINT_TYPES } from './look';

// SP1c HC3. D-32: the platform screens are mock-only, but the mock behaves like the contract: a password, a TOTP secret and a recovery code are kept as HASHES (hashOf, the HC2 mock hash; a real server stores a salted slow hash / an encrypted secret),
// a login failure never says which field was wrong, 5 consecutive failures lock, recovery codes are returned once. No credential and no token ever goes into the audit log, an activity row or a URL.

export interface Cred { userId: string; email: string; displayName: string; passwordHash: string; secretHash?: string; pendingSecretHash?: string; recovery: { hash: string; usedAt?: string }[] }
export interface Sess { id: string; userId: string; device: string; ip: string; createdAt: string; lastSeenAt: string; revokedAt?: string }
export interface AuthState { creds: Cred[]; sessions: Sess[]; current: string; failures: Record<string, { n: number; until?: number }>; challenges: Record<string, { userId: string; exp: number }> }
/** `hash` = hashOf(token): the token is shown once, to whoever made it. */
export interface PublicLink { id: string; companyId: string; docId: string; hash: string; createdAt: string; createdBy: string; revokedAt?: string }

/** The mock's demo identities (shown by GET /auth/demo in the mock only). Every TOTP secret in the mock is DEMO.secret, so every valid code is DEMO.totpCode. */
const SECRET = 'JBSWY3DPEHPK3PXP';
export const codeFor = (secretHash: string): string => String(parseInt(secretHash.slice(0, 8), 16) % 1_000_000).padStart(6, '0');
export const DEMO = {
  email: 'somsri@maliwan.example', password: 'Somsri#2026ok',
  totpEmail: 'wichai@maliwan.example', totpPassword: 'Wichai#2026ok',
  secret: SECRET, totpCode: codeFor(hashOf(SECRET)),
  recovery: ['RCV-7K2M-9QXA', 'RCV-4HTR-W3LD', 'RCV-B8NC-5YEF', 'RCV-2PVJ-X6GU'],
};
/** Fixed public tokens for the seed (a made token is random). */
export const FIXTURE_TOKENS = { ti: 'c41f9a7be2d05863fa1c7e9b3d28a5f60b94e1d7', qt: '7be3a05d9c1f4286e0b7d35a1f89c264d0e5a3b8' };

const LOCK_AFTER = 5, LOCK_MS = 15 * 60_000;
const err = (status: number, code: string, title: string) => new MockError(status, code, title);
const INVALID = () => err(401, 'auth.invalid_credentials', 'อีเมลหรือรหัสผ่านไม่ถูกต้อง');
const LOCKED = () => err(429, 'auth.locked', 'พยายามเข้าสู่ระบบผิดหลายครั้ง บัญชีถูกล็อกชั่วคราว 15 นาที ลองใหม่ภายหลัง');
const randomHex = (bytes: number) => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('');
const recoveryCode = () => { const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; const pick = (n: number) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => c[b % c.length]).join(''); return `RCV-${pick(4)}-${pick(4)}`; };

const auth = (st: MockState): AuthState => (st.auth ??= { creds: [], sessions: [], current: '', failures: {}, challenges: {} });
const credOf = (st: MockState, userId: string): Cred => {
  const c = auth(st).creds.find((x) => x.userId === userId);
  if (!c) throw err(404, 'auth.user_not_found', 'ไม่พบผู้ใช้');
  return c;
};
/** The user the browser is signed in as: the owner of the current session (u-1 until someone else logs in). */
export const currentUserId = (st: MockState): string => auth(st).sessions.find((s) => s.id === auth(st).current && !s.revokedAt)?.userId ?? 'u-1';

// the failure counter is per email (an unknown email has one too: the same answers, so the lock is no oracle)
const keyOf = (email: string) => hashOf(email.trim().toLowerCase());
function guard(st: MockState, key: string): void {
  const f = auth(st).failures[key];
  if (f?.until && f.until > Date.now()) throw LOCKED();
  if (f?.until) delete auth(st).failures[key];
}
function miss(st: MockState, key: string): void {
  const f = (auth(st).failures[key] ??= { n: 0 });
  f.n += 1;
  if (f.n >= LOCK_AFTER) f.until = Date.now() + LOCK_MS;
}
const locked = (st: MockState, key: string): boolean => !!auth(st).failures[key]?.until;

function openSession(st: MockState, c: Cred): string {
  const a = auth(st);
  delete a.failures[keyOf(c.email)]; // a full sign-in resets the counter
  const id = `ses-${Math.max(0, ...a.sessions.map((s) => Number(s.id.slice(4)) || 0)) + 1}`;
  a.sessions.push({ id, userId: c.userId, device: 'Chrome · Windows', ip: '127.0.0.1', createdAt: stamp(), lastSeenAt: stamp() });
  a.current = id;
  const co = st.memberships.find((m) => m.userId === c.userId)?.companyId ?? 'co-vat';
  logAudit(st, { kind: 'user', id: c.userId, name: c.displayName }, co, 'auth.login', c.userId);
  return id;
}

export type LoginResult = { status: 'ok'; sessionId: string } | { status: 'totp_required'; challenge: string };
export function login(st: MockState, email: string, password: string): LoginResult {
  const key = keyOf(email);
  guard(st, key);
  const c = auth(st).creds.find((x) => x.email.toLowerCase() === email.trim().toLowerCase());
  if (!c || c.passwordHash !== hashOf(password)) { miss(st, key); throw INVALID(); } // an unknown email and a wrong password are the same answer
  if (c.secretHash) {
    const challenge = randomHex(16);
    auth(st).challenges[challenge] = { userId: c.userId, exp: Date.now() + 5 * 60_000 };
    return { status: 'totp_required', challenge };
  }
  return { status: 'ok', sessionId: openSession(st, c) };
}

export function verifyTotp(st: MockState, challenge: string, v: { code?: string; recoveryCode?: string }): { sessionId: string } {
  const a = auth(st), ch = a.challenges[challenge];
  if (!ch || ch.exp < Date.now()) { delete a.challenges[challenge]; throw err(401, 'auth.challenge_invalid', 'การเข้าสู่ระบบหมดอายุ กรอกอีเมลและรหัสผ่านใหม่อีกครั้ง'); }
  const c = credOf(st, ch.userId), key = keyOf(c.email);
  guard(st, key);
  let ok = false;
  if (typeof v.code === 'string') ok = !!c.secretHash && /^\d{6}$/.test(v.code) && v.code === codeFor(c.secretHash);
  else if (typeof v.recoveryCode === 'string') {
    const h = hashOf(v.recoveryCode.trim().toUpperCase());
    const r = c.recovery.find((x) => x.hash === h && !x.usedAt);
    if (r) { r.usedAt = stamp(); ok = true; }
  }
  if (!ok) {
    miss(st, key);
    if (locked(st, key)) { delete a.challenges[challenge]; throw LOCKED(); }
    throw err(401, 'auth.totp_invalid', 'รหัสยืนยันไม่ถูกต้อง');
  }
  delete a.challenges[challenge];
  return { sessionId: openSession(st, c) };
}

export const profileOf = (st: MockState, userId: string) => {
  const c = credOf(st, userId);
  return { userId, email: c.email, displayName: c.displayName, totpEnabled: !!c.secretHash, recoveryRemaining: c.recovery.filter((r) => !r.usedAt).length };
};

/** Enrolment, step 1: the fixture secret for the QR placeholder. Only its hash is kept (pending until a code proves the app has it). */
export function startEnrol(st: MockState, actor: Actor, userId: string): { secret: string; uri: string } {
  refuseAgent(actor);
  const c = credOf(st, userId);
  c.pendingSecretHash = hashOf(SECRET);
  logAudit(st, actor, 'co-vat', 'auth.totp.enrol_start', userId);
  return { secret: SECRET, uri: `otpauth://totp/TEAS:${encodeURIComponent(c.email)}?secret=${SECRET}&issuer=TEAS` };
}
/** Step 2: the right code turns TOTP on and returns the recovery codes - THIS call is the only time they exist in clear. */
export function confirmEnrol(st: MockState, actor: Actor, userId: string, code: string): { recoveryCodes: string[] } {
  refuseAgent(actor);
  const c = credOf(st, userId), key = keyOf(c.email);
  if (!c.pendingSecretHash) throw err(409, 'auth.enrol_not_started', 'ยังไม่ได้เริ่มตั้งค่ารหัสยืนยันสองขั้น เริ่มใหม่อีกครั้ง');
  guard(st, key);
  if (!/^\d{6}$/.test(code) || code !== codeFor(c.pendingSecretHash)) { miss(st, key); throw err(401, 'auth.totp_invalid', 'รหัสยืนยันไม่ถูกต้อง'); }
  const recoveryCodes = Array.from({ length: 8 }, recoveryCode);
  c.secretHash = c.pendingSecretHash;
  delete c.pendingSecretHash;
  c.recovery = recoveryCodes.map((r) => ({ hash: hashOf(r) }));
  logAudit(st, actor, 'co-vat', 'auth.totp.enable', userId, undefined, { recoveryCodes: recoveryCodes.length });
  return { recoveryCodes };
}

const STRENGTH = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{10,}$/;
export function changePassword(st: MockState, actor: Actor, userId: string, v: { current: string; next: string; confirm: string }): void {
  refuseAgent(actor);
  const c = credOf(st, userId), key = keyOf(c.email);
  guard(st, key);
  if (c.passwordHash !== hashOf(String(v.current ?? ''))) { miss(st, key); throw err(422, 'auth.current_password_invalid', 'รหัสผ่านปัจจุบันไม่ถูกต้อง'); }
  if (v.next !== v.confirm) throw err(422, 'auth.password_mismatch', 'รหัสผ่านใหม่และการยืนยันไม่ตรงกัน');
  if (typeof v.next !== 'string' || !STRENGTH.test(v.next)) throw err(422, 'auth.password_weak', 'รหัสผ่านใหม่ต้องยาวอย่างน้อย 10 ตัวอักษร และมีตัวพิมพ์เล็ก ตัวพิมพ์ใหญ่ และตัวเลข');
  if (hashOf(v.next) === c.passwordHash) throw err(422, 'auth.password_reuse', 'รหัสผ่านใหม่ต้องไม่ซ้ำกับรหัสผ่านเดิม');
  c.passwordHash = hashOf(v.next);
  delete auth(st).failures[key];
  for (const s of auth(st).sessions) if (s.userId === userId && s.id !== auth(st).current && !s.revokedAt) s.revokedAt = stamp(); // a new password ends every other sign-in
  logAudit(st, actor, 'co-vat', 'auth.password.change', userId);
}
/** Re-login while the session is expired: the password of the signed-in user only (same counter, same answer). */
export function relogin(st: MockState, userId: string, password: string): void {
  const c = credOf(st, userId), key = keyOf(c.email);
  guard(st, key);
  if (c.passwordHash !== hashOf(password)) { miss(st, key); throw INVALID(); }
  delete auth(st).failures[key];
}

export const listSessions = (st: MockState, userId: string) =>
  auth(st).sessions.filter((s) => s.userId === userId && !s.revokedAt).map((s) => ({ id: s.id, device: s.device, ip: s.ip, createdAt: s.createdAt, lastSeenAt: s.lastSeenAt, current: s.id === auth(st).current }));
export function revokeSession(st: MockState, actor: Actor, userId: string, id: string): { signedOut: boolean } {
  refuseAgent(actor);
  const a = auth(st), s = a.sessions.find((x) => x.id === id && x.userId === userId && !x.revokedAt);
  if (!s) throw err(404, 'auth.session_not_found', 'ไม่พบอุปกรณ์ที่เข้าสู่ระบบนี้');
  s.revokedAt = stamp();
  logAudit(st, actor, 'co-vat', 'auth.session.revoke', id);
  const signedOut = id === a.current;
  if (signedOut) a.current = '';
  return { signedOut };
}
export function logout(st: MockState): void {
  const a = auth(st), s = a.sessions.find((x) => x.id === a.current);
  if (s) s.revokedAt = stamp();
  a.current = '';
}

// ---------------------------------------------------------------- public links (ruling 5)

const docOf = (st: MockState, companyId: string, docId: string) => {
  const d = st.docs.find((x) => x.id === docId && x.companyId === companyId);
  if (!d) throw err(404, 'doc.not_found', 'ไม่พบเอกสาร');
  return d;
};
/** A link exists only for an ISSUED printable document; the token is random (never derived from the id) and kept as a hash. `token` is for the seed only. */
export function createPublicLink(st: MockState, actor: Actor, companyId: string, docId: string, token?: string): { token: string } {
  refuseAgent(actor);
  const d = docOf(st, companyId, docId);
  if (!DOC_TYPES[d.type].printable || !PRINT_TYPES.includes(d.type)) throw err(422, 'public.not_printable', 'เอกสารประเภทนี้ไม่มีแบบพิมพ์ จึงสร้างลิงก์สาธารณะไม่ได้');
  if (!LIVE.includes(d.status)) throw err(409, 'public.not_issued', 'สร้างลิงก์สาธารณะได้เฉพาะเอกสารที่ออกแล้วและยังไม่ถูกยกเลิก');
  const links = (st.publicLinks ??= []);
  const t = token ?? randomHex(20);
  const link: PublicLink = { id: `pl-${links.length + 1}`, companyId, docId, hash: hashOf(t), createdAt: stamp(), createdBy: actor.id };
  links.push(link);
  logAudit(st, actor, companyId, 'public_link.create', docId, undefined, { linkId: link.id }); // never the token
  return { token: t };
}
/** Every live link of the document ends. Returns how many. */
export function revokePublicLinks(st: MockState, actor: Actor, companyId: string, docId: string): number {
  refuseAgent(actor);
  docOf(st, companyId, docId);
  const live = (st.publicLinks ?? []).filter((l) => l.companyId === companyId && l.docId === docId && !l.revokedAt);
  for (const l of live) l.revokedAt = stamp();
  if (live.length) logAudit(st, actor, companyId, 'public_link.revoke', docId, { links: live.length }, { links: 0 });
  return live.length;
}
export const activeLinkCount = (st: MockState, companyId: string, docId: string): number => (st.publicLinks ?? []).filter((l) => l.companyId === companyId && l.docId === docId && !l.revokedAt).length;
/** The document behind a token - or nothing, whatever the reason (unknown, revoked, document cancelled / replaced / not issued): one answer, no oracle. */
export function resolvePublicLink(st: MockState, token: string): { link: PublicLink; doc: MockState['docs'][number] } | undefined {
  const h = hashOf(token);
  const link = (st.publicLinks ?? []).find((l) => l.hash === h && !l.revokedAt);
  const doc = link && st.docs.find((d) => d.id === link.docId && d.companyId === link.companyId);
  return link && doc && LIVE.includes(doc.status) ? { link, doc } : undefined;
}

// ---------------------------------------------------------------- onboarding (ruling 2, D-03)

const MONTHS_OK = 1; // the engine supports the calendar year only [SP-R]: updateCompany refuses any other value with company.fiscal_year_unsupported
type Body = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** Creates `co-new` through the company and bank commands (identity / fiscal sections, the bank-account record), gives it the chart template, posting rules, tax types and an administrator membership for the signed-in user. All or nothing. */
export function onboard(st: MockState, actor: Actor, v: Body): { companyId: string; cutoff: string } {
  refuseAgent(actor);
  const id = 'co-new';
  if (st.companies.some((c) => c.id === id)) throw err(409, 'company.exists', 'มีบริษัทที่สร้างจากหน้านี้แล้ว รีเซ็ตข้อมูลตัวอย่างเพื่อเริ่มใหม่');
  const snap = structuredClone(st);
  try {
    const e: Record<string, string[]> = {};
    if (v.template !== 'sme-th') e.template = ['ต้องเลือกแม่แบบผังบัญชี'];
    if (typeof v.vatRegistered !== 'boolean') e.vatRegistered = ['ต้องเลือกสถานะ VAT'];
    if (Object.keys(e).length) throw new FieldErrors(e);
    const co: Company = { id, legalNameTh: str(v.legalNameTh), taxId: '', branchCode: '00000', vatRegistered: v.vatRegistered === true, address: '-', fiscalYearStartMonth: MONTHS_OK, defaultNotes: { ...DEFAULT_NOTES } };
    st.companies.push(co);
    st.accounts.push(...chartOfAccounts().map((a) => ({ ...a, companyId: id })));
    st.postingRules.push(...postingRulesFor(id, {}));
    st.whtTypes.push(...whtTypesFor(id));
    st.settlementTolerance.push({ companyId: id, rounding: '1.00', smallWriteOff: '100.00' });
    updateCompany(st, actor, id, 'identity', { legalNameTh: v.legalNameTh, taxId: v.taxId, branchCode: v.branchCode, address: v.address, confirm: true });
    updateCompany(st, actor, id, 'fiscal', { fiscalYearStartMonth: v.fiscalYearStartMonth });
    const bank = (v.bank ?? {}) as Body, kind = bank.kind === 'cash' ? 'cash' : 'bank';
    const row = { ...bank, kind, accountCode: kind === 'cash' ? '1110' : '1121' };
    const be = bankAccountImpl.validate(row, st, id);
    if (Object.keys(be).length) throw new FieldErrors(Object.fromEntries(Object.entries(be).map(([k, m]) => [`bank.${k}`, m])));
    const made = bankAccountImpl.create(st, id, row);
    const acct = st.bankAccounts.find((b) => b.id === made.id)!;
    acct.default = true; // the first account is the one new receipts and payments start with
    const cutoff = str(v.cutoff), limit = new Date(Date.parse(`${firstOpenMonthStart(st, id)}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(cutoff) || Number.isNaN(Date.parse(cutoff))) throw new FieldErrors({ cutoff: ['ต้องระบุวันตัดยอดยกมา'] });
    if (cutoff > limit) throw new FieldErrors({ cutoff: [`วันตัดยอดต้องไม่เกิน ${limit} (วันก่อนเริ่มงวดบัญชีแรกที่ยังเปิดอยู่)`] });
    const name = st.companies.find((c) => c.id === id)!.legalNameTh;
    st.staff.push({ id: 'usr-new-1', companyId: id, userId: 'u-1', name: actor.name, email: credOf(st, 'u-1').email, roleId: 'admin', position: 'ผู้ดูแลระบบ', active: true, version: 1, invitePending: false });
    st.memberships.push({ userId: 'u-1', companyId: id, companyName: name, role: 'admin' as Role });
    logAudit(st, actor, id, 'company.create', id, undefined, { id, legalNameTh: name, vatRegistered: co.vatRegistered, template: v.template, cutoff });
    return { companyId: id, cutoff };
  } catch (e) {
    for (const k of Object.keys(st)) delete (st as unknown as Body)[k];
    Object.assign(st, snap);
    throw e;
  }
}

// ---------------------------------------------------------------- seed

/** Two login identities (one with TOTP and recovery codes), three sessions of u-1, and the two fixture public links (made by the command, with fixed tokens). */
export function seedAuth(st: MockState): void {
  st.auth = { creds: [
    { userId: 'u-1', email: DEMO.email, displayName: 'สมศรี บัญชีดี', passwordHash: hashOf(DEMO.password), recovery: [] },
    { userId: 'usr-vat-2', email: DEMO.totpEmail, displayName: 'วิชัย ผู้ดูแลระบบ', passwordHash: hashOf(DEMO.totpPassword), secretHash: hashOf(SECRET), recovery: DEMO.recovery.map((r) => ({ hash: hashOf(r) })) },
  ], sessions: [], current: 'ses-1', failures: {}, challenges: {} };
  const at = '2026-10-13T09:00:00+07:00';
  withFixedClock(at, () => {
    for (const [i, device] of ['Chrome · Windows', 'Safari · iPhone', 'Edge · Windows'].entries()) {
      st.auth!.sessions.push({ id: `ses-${i + 1}`, userId: 'u-1', device, ip: i ? `203.0.113.${10 + i}` : '127.0.0.1', createdAt: stamp(), lastSeenAt: stamp() });
    }
    const ti = st.docs.find((d) => FIXTURE_PREDICATES.tiIssuedUnpaid(d, st)), qt = st.docs.find((d) => FIXTURE_PREDICATES.qtIssued(d, st));
    if (ti) createPublicLink(st, { kind: 'user', id: 'u-1', name: 'สมศรี บัญชีดี' }, ti.companyId, ti.id, FIXTURE_TOKENS.ti);
    if (qt) createPublicLink(st, { kind: 'user', id: 'u-1', name: 'สมศรี บัญชีดี' }, qt.companyId, qt.id, FIXTURE_TOKENS.qt);
  });
}
