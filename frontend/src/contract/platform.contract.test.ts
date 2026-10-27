import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import en from '@/messages/en.json';
import th from '@/messages/th.json';
import { SCREENS } from '@/app/mock/screens/screens';
import { handlers } from '@/mocks/handlers';
import { PERMISSIONS_BY_ROLE } from '@/mocks/permissions';
import { SYSTEM_ROLE_NAMES } from '@/mocks/records/roles';
import { setSession, setSettings } from '@/mocks/settings';
import { loadState, resetState, saveState } from '@/mocks/store';
import { testServer } from '@/mocks/test-server';
import { CONTRACT_VERSION, ERROR_CODES, PERMISSION_CODES, ROUTES, SYSTEM_ROLES, agentForbidden, type LinkInfo, type Me } from './platform';

// SP3 P0 (docs/specs/SP3-platform.md section 11): the contract and the mock agree, in both directions.
const key = (method: string, path: string) => `${method.toUpperCase()} ${path.replace(/^.*\/bff\/v1/, '').replace(/[:{][^/}]+}?/g, '{}')}`;
const SCOPE = [/^\/auth(\/|$)/, /^\/me(\/|$)/, /^\/settings\/(companies|users|roles|default-notes)(\/|$)/, /^\/connect\/keys(\/|$)/];
/** The mock-only surface: never part of the contract; the real API answers 404 (master plan 2.3). */
const MOCK_ONLY = ['GET /auth/demo', 'POST /settings/users/{}/accept'];

beforeAll(() => testServer.listen({ onUnhandledFrame: 'error' }));
afterEach(() => testServer.resetHandlers());
afterAll(() => testServer.close());
beforeEach(() => { localStorage.clear(); resetState(); setSettings({ companyKey: 'vat', role: 'admin', screenState: 'normal' }); });
const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const r = await fetch(`http://localhost/bff/v1${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: (await r.json().catch(() => undefined)) as Record<string, unknown> };
};

describe('ROUTES (spec 5.3 rows 1-34)', () => {
  it('is frozen at 1.0 with 34 distinct rows', () => {
    expect(CONTRACT_VERSION).toBe('1.0');
    expect(ROUTES).toHaveLength(34);
    expect(new Set(ROUTES.map((r) => key(r.method, r.path))).size).toBe(34);
  });
  it('uses only registered error codes and catalog permissions', () => {
    for (const r of ROUTES) {
      for (const e of r.errors) expect(ERROR_CODES, `${r.method} ${r.path}: ${e}`).toHaveProperty([e]);
      if (typeof r.permission === 'string') expect(PERMISSION_CODES, r.path).toContain(r.permission);
    }
  });
  const handled = handlers.flatMap((h) => { const i = (h as unknown as { info: { method: unknown; path: unknown } }).info; return typeof i.method === 'string' && typeof i.path === 'string' ? [key(i.method, i.path)] : []; });
  it('every ROUTES entry has an MSW handler (the machine route has none: it is not under /bff)', () => {
    for (const r of ROUTES.filter((x) => x.auth !== 'key')) expect(handled, `${r.method} ${r.path}`).toContain(key(r.method, r.path));
  });
  it('every MSW handler of the platform paths has a ROUTES entry (except the named mock-only surface)', () => {
    const routes = new Set(ROUTES.map((r) => key(r.method, r.path)));
    const inScope = handled.filter((k) => SCOPE.some((re) => re.test(k.slice(k.indexOf(' ') + 1))));
    expect(inScope.length).toBeGreaterThan(30);
    expect(inScope.filter((k) => !routes.has(k) && !MOCK_ONLY.includes(k))).toEqual([]);
    for (const k of MOCK_ONLY) expect(handled).toContain(k); // the exemption list stays honest
  });
});

describe('permission catalog', () => {
  const codes = Object.keys(th.permissions).map((k) => k.replaceAll('_', '.'));
  it('PERMISSION_CODES = th.json#permissions keys (and en.json has the same)', () => {
    expect([...PERMISSION_CODES].sort()).toEqual([...codes].sort());
    expect(Object.keys(en.permissions).sort()).toEqual(Object.keys(th.permissions).sort());
  });
  it('every code of SYSTEM_ROLES is in the catalog; the mock imports the same lists', () => {
    for (const [role, list] of Object.entries(SYSTEM_ROLES)) for (const c of list) expect(PERMISSION_CODES, `${role}: ${c}`).toContain(c);
    expect(SYSTEM_ROLES.operator).toHaveLength(42);
    expect(SYSTEM_ROLES.accountant).toHaveLength(128);
    expect(SYSTEM_ROLES.admin).toHaveLength(13);
    expect(PERMISSIONS_BY_ROLE).toEqual(SYSTEM_ROLES);
  });
  it('agentForbidden = SP3 4.5: the ten settings-class rights and approve / cancel / correct of any type', () => {
    const ten = ['settings.manage', 'users.manage', 'connect.manage', 'ledger.period.close', 'ledger.period.reopen', 'tax.filing.finalize', 'tax.settings.manage', 'ledger.posting.manage', 'ledger.coa.manage', 'ledger.schedule.manage'];
    for (const c of ten) expect(agentForbidden(c), c).toBe(true);
    const doc = PERMISSION_CODES.filter((c) => /^doc\.[A-Z]+\./.test(c));
    expect(doc.length).toBeGreaterThan(80);
    for (const c of doc) expect(agentForbidden(c), c).toBe(/\.(approve|cancel|correct)$/.test(c));
    expect(PERMISSION_CODES.filter((c) => !ten.includes(c) && !/^doc\./.test(c) && agentForbidden(c))).toEqual([]);
    expect(agentForbidden('doc.TI.cancelled')).toBe(false);
    expect(agentForbidden('xdoc.TI.cancel')).toBe(false);
  });
});

describe('Membership carries the role by id and name', () => {
  it('a system role: roleName is the system name', async () => {
    setSettings({ role: 'accountant' });
    const me = (await call('GET', '/me')).json as unknown as Me;
    const vat = me.memberships.find((m) => m.companyId === 'co-vat')!;
    expect(vat).toEqual({ companyId: 'co-vat', companyName: expect.any(String), roleId: 'accountant', roleName: SYSTEM_ROLE_NAMES.accountant });
    expect(me.memberships.find((m) => m.companyId === 'co-nonvat')).toMatchObject({ roleId: 'operator', roleName: SYSTEM_ROLE_NAMES.operator });
    expect(me.memberships.every((m) => !('role' in m))).toBe(true);
    expect(me.activeCompanyId).toBe('co-vat');
  });
  it('a custom role: roleName is the custom role name', async () => {
    const made = (await call('POST', '/settings/roles', { name: 'ผู้ตรวจสอบ', permissions: ['audit.read', 'report.read'] })).json as { id: string };
    const upd = await call('PUT', '/settings/users/usr-vat-1', { roleId: made.id, version: 1 });
    expect(upd.status).toBe(200);
    const me = (await call('GET', '/me')).json as unknown as Me;
    expect(me.memberships.find((m) => m.companyId === 'co-vat')).toMatchObject({ roleId: made.id, roleName: 'ผู้ตรวจสอบ' });
  });
});

describe('Me without a company', () => {
  it('a user with no membership gets activeCompanyId null, no memberships and no rights (the bootstrap admin, SP3 4.4)', async () => {
    const st = loadState();
    st.memberships = [];
    saveState(st);
    const me = (await call('GET', '/me')).json as unknown as Me;
    expect(me).toMatchObject({ userId: 'u-1', activeCompanyId: null, memberships: [], permissions: [], vatRegistered: false });
  });
});

describe('screen index (backlog B-5)', () => {
  it('every screen name has a label in both message files', () => {
    for (const s of SCREENS) {
      expect((th.screens.name as Record<string, string>)[s.name], `th ${s.name}`).toBeTruthy();
      expect((en.screens.name as Record<string, string>)[s.name], `en ${s.name}`).toBeTruthy();
    }
  });
  it('the new error codes have a Thai and an English title', () => {
    for (const c of ['auth.link_invalid', 'connect.key_kind_mismatch', 'idempotency.key_required', 'idempotency.key_reused', 'http.rate_limited']) {
      const k = c.replaceAll('.', '_');
      expect((th.errorCodes as Record<string, string>)[k], `th ${c}`).toBeTruthy();
      expect((en.errorCodes as Record<string, string>)[k], `en ${c}`).toBeTruthy();
    }
  });
});

describe('role delete is version-checked (route 29)', () => {
  it('DELETE /settings/roles/{id}?version= : stale 409, current 200, missing 409', async () => {
    const made = (await call('POST', '/settings/roles', { name: 'ชั่วคราว', permissions: ['audit.read'] })).json as { id: string; version: number };
    expect((await call('DELETE', `/settings/roles/${made.id}?version=${made.version + 1}`)).json).toMatchObject({ code: 'record.version_conflict' });
    expect((await call('DELETE', `/settings/roles/${made.id}`)).json).toMatchObject({ code: 'record.version_conflict' });
    expect((await call('DELETE', `/settings/roles/${made.id}?version=${made.version}`)).status).toBe(200);
    expect(loadState().roles.find((r) => r.id === made.id)).toBeUndefined();
  });
});

describe('totp-reset (route 25)', () => {
  const cred = (email: string) => loadState().auth!.creds.find((c) => c.email === email)!;
  it('clears the member second factor, bumps the version and is audited; never on yourself', async () => {
    expect(cred('wichai@maliwan.example').secretHash).toBeTruthy();
    const r = await call('POST', '/settings/users/usr-vat-2/totp-reset', { version: 1 });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ id: 'usr-vat-2', version: 2 });
    expect(cred('wichai@maliwan.example').secretHash).toBeUndefined();
    expect(cred('wichai@maliwan.example').recovery).toEqual([]);
    expect(loadState().audit.some((a) => a.command === 'user.totp_reset' && a.target === 'usr-vat-2')).toBe(true);
    expect((await call('POST', '/settings/users/usr-vat-2/totp-reset', { version: 1 })).json).toMatchObject({ code: 'record.version_conflict' });
    expect((await call('POST', '/settings/users/usr-vat-1/totp-reset', { version: 1 })).json).toMatchObject({ code: 'auth.forbidden' });
  });
  it('is refused for an agent and for a caller without users.manage', async () => {
    expect((await call('POST', '/settings/users/usr-vat-2/totp-reset', { version: 1 }, { 'x-teas-actor': 'agent' })).json).toMatchObject({ code: 'agent.forbidden_setting' });
    setSettings({ role: 'operator' });
    expect((await call('POST', '/settings/users/usr-vat-2/totp-reset', { version: 1 })).status).toBe(403);
  });
});

describe('invite / reset links (routes 13-14, Q4)', () => {
  const INVALID = 'ลิงก์นี้ใช้ไม่ได้แล้วหรือหมดอายุ ขอลิงก์ใหม่จากผู้ดูแลระบบ';
  const tokenOf = (url: unknown) => String(url).split('/link/')[1]!;
  it('an unknown token and a used token give ONE identical answer', async () => {
    const unknown = await call('GET', '/auth/links/not-a-link');
    expect(unknown.status).toBe(404);
    expect(unknown.json).toMatchObject({ code: 'auth.link_invalid', title: INVALID });
    const made = (await call('POST', '/settings/users', { name: 'ใหม่ ทดสอบ', email: 'new@maliwan.example', roleId: 'operator' })).json as { link: string };
    expect(made.link).toMatch(/\/link\/[\w-]+$/);
    const t = tokenOf(made.link);
    expect((await call('POST', `/auth/links/${t}`, { password: 'Strong#Pass2026', confirm: 'Strong#Pass2026' })).status).toBe(200);
    const used = await call('GET', `/auth/links/${t}`);
    expect(used.status).toBe(404);
    expect({ ...used.json, traceId: 0 }).toEqual({ ...unknown.json, traceId: 0 });
  });
  it('an invite: info, validation, then accepts (member active, audited, can sign in)', async () => {
    const made = (await call('POST', '/settings/users', { name: 'ใหม่ ทดสอบ', email: 'new@maliwan.example', roleId: 'operator' })).json as { link: string; id: string };
    const t = tokenOf(made.link);
    const info = (await call('GET', `/auth/links/${t}`)).json as unknown as LinkInfo;
    expect(info).toMatchObject({ kind: 'invite', email: 'new@maliwan.example', companyName: expect.any(String), expiresAt: expect.stringMatching(/^\d{4}-/) });
    expect((await call('POST', `/auth/links/${t}`, { password: 'Strong#Pass2026', confirm: 'Different#Pass1' })).json).toMatchObject({ code: 'auth.password_mismatch' });
    expect((await call('POST', `/auth/links/${t}`, { password: 'weak', confirm: 'weak' })).json).toMatchObject({ code: 'auth.password_weak' });
    expect((await call('GET', `/auth/links/${t}`)).status).toBe(200); // a refused attempt does not spend the link
    expect((await call('POST', `/auth/links/${t}`, { password: 'Strong#Pass2026', confirm: 'Strong#Pass2026' })).json).toEqual({ status: 'ok' });
    const row = loadState().staff.find((m) => m.id === made.id)!;
    expect(row.invitePending).toBe(false);
    expect(row.linkHash).toBeUndefined();
    expect(loadState().audit.some((a) => a.command === 'user.accept_invite' && a.target === made.id)).toBe(true);
    expect((await call('POST', '/auth/login', { email: 'new@maliwan.example', password: 'Strong#Pass2026' })).json).toMatchObject({ status: 'ok' });
  });
  it('a reset link sets a new password for a user with an account', async () => {
    const { link } = (await call('POST', '/settings/users/usr-vat-2/reset-link', {})).json as { link: string };
    const t = tokenOf(link);
    expect((await call('GET', `/auth/links/${t}`)).json).toMatchObject({ kind: 'reset', email: 'wichai@maliwan.example' });
    expect((await call('POST', `/auth/links/${t}`, { password: 'Fresh#Pass2026x', confirm: 'Fresh#Pass2026x' })).json).toEqual({ status: 'ok' });
    expect((await call('POST', '/auth/login', { email: 'wichai@maliwan.example', password: 'Fresh#Pass2026x' })).json).toMatchObject({ status: 'totp_required' });
    expect(loadState().audit.some((a) => a.command === 'auth.password.reset')).toBe(true);
    expect((await call('GET', `/auth/links/${t}`)).status).toBe(404);
  });
  it('works without a session, is refused for an agent, and the fixture tokens are stable', async () => {
    setSession('out');
    const fixture = await call('GET', '/auth/links/inv-5c1e8a3f7b2d4690');
    expect(fixture.json).toMatchObject({ kind: 'invite', email: expect.any(String) });
    expect((await call('GET', '/auth/links/rst-9d4b2f6a1c7e3850')).json).toMatchObject({ kind: 'reset' });
    expect((await call('GET', '/auth/links/inv-5c1e8a3f7b2d4690', undefined, { 'x-teas-actor': 'agent' })).status).toBe(403);
    expect((await call('POST', '/auth/links/inv-5c1e8a3f7b2d4690', { password: 'Strong#Pass2026', confirm: 'Strong#Pass2026' })).json).toEqual({ status: 'ok' });
    expect((await call('GET', '/auth/links/inv-5c1e8a3f7b2d4690')).status).toBe(200); // fixtures are reusable
  });
});
