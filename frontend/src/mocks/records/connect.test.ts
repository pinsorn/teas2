import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AGENT, USER } from '../fixtures/documents';
import { PERMISSIONS_BY_ROLE, permissionsOf } from '../permissions';
import { setSettings } from '../settings';
import { buildSeedState, loadState, resetState } from '../store';
import { testServer } from '../test-server';
import { createKey, rotateKey, revokeKey, authenticateKey, rightsOf, setPolicy, policyView, policyOf, listKeys, listApps, revokeApp, consentInfo, decideConsent } from './connect';

beforeAll(() => testServer.listen({ onUnhandledFrame: 'error' }));
afterEach(() => testServer.resetHandlers());
afterAll(() => testServer.close());
beforeEach(() => { localStorage.clear(); resetState(); setSettings({ companyKey: 'vat', role: 'admin', screenState: 'normal' }); });

const V = 'co-vat', N = 'co-nonvat';
const OWNER = { id: 'u-1', name: USER.name, perms: PERMISSIONS_BY_ROLE.accountant };
const code = (f: () => unknown) => { try { f(); } catch (e) { return (e as { message: string }).message.split(':')[0]; } return undefined; };
const seed = () => buildSeedState('accountant');
const call = (method: string, path: string, body?: unknown, agent = false) =>
  fetch(`http://localhost/bff/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(agent ? { 'x-teas-actor': 'agent' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });

describe('ruling 1: the secret is returned once and stored as a hash + prefix', () => {
  it('create returns it; the list, the stored state and the audit entry never carry it', () => {
    const st = seed();
    const { key, secret } = createKey(st, USER, V, OWNER, { name: 'ทดสอบ', kind: 'rest', scopes: ['report.read'] });
    expect(secret).toMatch(/^teas_rest_[0-9a-f]{48}$/);
    expect(key.prefix).toBe(secret.slice(0, 14));
    expect(JSON.stringify(listKeys(st, V))).not.toContain(secret);
    expect(JSON.stringify(st)).not.toContain(secret.slice(14)); // the state holds the hash and the prefix only
    expect(JSON.stringify(st.audit.filter((a) => a.command.startsWith('connect.key')))).not.toContain(secret.slice(14));
    expect(JSON.stringify(st.audit.filter((a) => a.command.startsWith('connect.key')))).not.toMatch(/"hash"/);
    expect(st.audit.at(-1)).toMatchObject({ command: 'connect.key.create', target: key.id });
  });
  it('over the wire: only the create / rotate response has a secret; GET /connect/keys has none', async () => {
    const made = await (await call('POST', '/connect/keys', { name: 'k', kind: 'mcp', scopes: ['report.read'] })).json() as { key: { id: string; version: number }; secret: string };
    expect(made.secret).toMatch(/^teas_mcp_/);
    expect(JSON.stringify(await (await call('GET', '/connect/keys')).json())).not.toContain(made.secret.slice(14));
    const rot = await (await call('POST', `/connect/keys/${made.key.id}/rotate`, { version: made.key.version })).json() as { secret: string };
    expect(rot.secret).not.toBe(made.secret);
    expect(JSON.stringify(await (await call('GET', '/connect/keys')).json())).not.toContain(rot.secret.slice(14));
    expect(JSON.stringify(loadState())).not.toContain(rot.secret.slice(14));
  });
  it('rotate revokes the old key in the same command; revoked and expired keys are refused', () => {
    const st = seed();
    const a = createKey(st, USER, V, OWNER, { name: 'a', kind: 'rest', scopes: ['report.read'] });
    expect(authenticateKey(st, a.secret, V).rights).toEqual(['report.read']);
    const b = rotateKey(st, USER, V, a.key.id, a.key.version);
    expect(code(() => authenticateKey(st, a.secret, V))).toBe('connect.key_revoked');
    expect(authenticateKey(st, b.secret, V).key).toMatchObject({ name: 'a', status: 'active' });
    expect(listKeys(st, V).find((k) => k.id === a.key.id)?.status).toBe('revoked');
    expect(code(() => rotateKey(st, USER, V, a.key.id, a.key.version + 1))).toBe('connect.key_revoked');
    const c = createKey(st, USER, V, OWNER, { name: 'c', kind: 'rest', scopes: ['report.read'] });
    revokeKey(st, USER, V, c.key.id, c.key.version);
    expect(code(() => authenticateKey(st, c.secret, V))).toBe('connect.key_revoked');
    const d = createKey(st, USER, V, OWNER, { name: 'd', kind: 'rest', scopes: ['report.read'], expiresAt: '2026-12-31' });
    st.apiKeys!.find((k) => k.id === d.key.id)!.expiresAt = '2026-10-01';
    expect(code(() => authenticateKey(st, d.secret, V))).toBe('connect.key_expired');
    expect(code(() => authenticateKey(st, `${d.secret.slice(0, 14)}${'0'.repeat(48)}`, V))).toBe('connect.key_invalid'); // right prefix, wrong secret
  });
  it('an agent is refused every key write (before the body); a stale version is a 409; the list shows prefix, owner, last used, scope count', async () => {
    const st = seed();
    expect(code(() => createKey(st, AGENT, V, OWNER, { name: 'x', kind: 'rest', scopes: ['report.read'] }))).toBe('agent.forbidden_setting');
    const r = await call('POST', '/connect/keys', {}, true);
    expect({ s: r.status, c: (await r.json() as { code: string }).code }).toEqual({ s: 403, c: 'agent.forbidden_setting' });
    const k = listKeys(st, V)[0];
    expect(code(() => revokeKey(st, USER, V, k.id, k.version + 5))).toBe('record.version_conflict');
    expect(k).toMatchObject({ prefix: expect.stringMatching(/^teas_/), ownerName: USER.name, scopeCount: k.scopes.length });
    expect(k.lastUsedAt).toBeTruthy();
  });
});

describe('ruling 2: scopes are bounded by the owner, on this company', () => {
  it('create refuses a scope the owner does not hold (connect.scope_exceeds) and a §8.5 right (connect.scope_forbidden)', () => {
    const st = seed();
    const n = st.apiKeys!.length, a = st.audit.length;
    const op = { ...OWNER, perms: PERMISSIONS_BY_ROLE.operator };
    expect(code(() => createKey(st, USER, V, op, { name: 'x', kind: 'rest', scopes: ['report.read'] }))).toBe('connect.scope_exceeds'); // the operator holds no report.read
    expect(code(() => createKey(st, USER, V, { ...OWNER, perms: [...OWNER.perms, 'settings.manage'] }, { name: 'x', kind: 'rest', scopes: ['settings.manage'] }))).toBe('connect.scope_forbidden');
    expect({ keys: st.apiKeys!.length, audit: st.audit.length }).toEqual({ keys: n, audit: a }); // a refusal writes nothing
  });
  it('at USE the key holds scopes ∩ the owner\'s CURRENT rights: a demoted or deactivated owner\'s key loses them', () => {
    const st = seed();
    const k = createKey(st, USER, V, OWNER, { name: 'x', kind: 'rest', scopes: ['report.read', 'party.read'] });
    expect(authenticateKey(st, k.secret, V).rights.sort()).toEqual(['party.read', 'report.read']);
    const me = st.staff.find((m) => m.companyId === V && m.userId === 'u-1')!;
    me.roleId = 'operator'; // demoted: the operator holds party.read but not report.read
    expect(permissionsOf(st, V, 'operator')).not.toContain('report.read');
    expect(authenticateKey(st, k.secret, V).rights).toEqual(['party.read']);
    me.active = false;
    expect(authenticateKey(st, k.secret, V).rights).toEqual([]);
    expect(rightsOf(st, V, 'u-1', ['report.read'])).toEqual([]);
  });
  it('a key belongs to its company: another company\'s keys are a 404 and the key does not work there', async () => {
    const st = seed();
    const k = createKey(st, USER, V, OWNER, { name: 'x', kind: 'rest', scopes: ['report.read'] });
    expect(listKeys(st, N)).toEqual([]);
    expect(code(() => revokeKey(st, USER, N, k.key.id, k.key.version))).toBe('record.not_found');
    expect(code(() => authenticateKey(st, k.secret, N))).toBe('connect.wrong_company');
    setSettings({ companyKey: 'nonvat', role: 'admin', screenState: 'normal' });
    expect((await call('POST', '/connect/keys/key-1/revoke', { version: 1 })).status).toBe(404);
  });
  it('the whole surface needs connect.manage: the accountant and the operator are forbidden', async () => {
    for (const role of ['accountant', 'operator'] as const) {
      setSettings({ companyKey: 'vat', role, screenState: 'normal' });
      for (const [m, p] of [['GET', '/connect/keys'], ['GET', '/connect/apps'], ['GET', '/connect/policy'], ['GET', '/oauth/consent-info?client=cl-assistant']]) expect([role, p, (await call(m, p)).status]).toEqual([role, p, 403]);
    }
  });
});

describe('ruling 3: the agent policy', () => {
  it('defaults: T-class Human, N / L Auto-if-clean with the 50,000.00 cap; the hard limits are a read-only list', () => {
    const st = seed();
    const v = policyView(st, V);
    expect(v.items.filter((r) => r.tClass).map((r) => r.docType).sort()).toEqual(['CN', 'DN', 'RC', 'TI']);
    for (const r of v.items) expect([r.docType, r.mode, r.cap]).toEqual([r.docType, r.tClass ? 'human' : 'auto', '50000.00']);
    expect(v.hardLimits.length).toBeGreaterThanOrEqual(8);
    expect(policyView(st, N).items.map((r) => r.docType)).not.toContain('TI'); // only the types the company can have
  });
  it('a T-class type can never be Auto; cancel / reissue are never Auto for any type; nothing is written on a refusal', () => {
    const st = seed();
    const n = st.audit.length;
    for (const t of ['TI', 'RC', 'CN', 'DN']) expect(code(() => setPolicy(st, USER, V, t, { mode: 'auto', cap: '1.00', version: 1 }))).toBe('agent.policy_t_class');
    expect(code(() => setPolicy(st, USER, V, 'PV', { mode: 'human', cap: '1.00', version: 1, autoCancel: true }))).toBe('agent.policy_cancel_auto');
    expect(code(() => setPolicy(st, USER, V, 'PV', { mode: 'human', cap: '1.00', version: 1, autoReissue: true }))).toBe('agent.policy_cancel_auto');
    expect(st.agentPolicies ?? []).toEqual([]);
    expect(st.audit).toHaveLength(n);
  });
  it('a write is audited, bumps the version, needs the current version and refuses an agent', async () => {
    const st = seed();
    expect(setPolicy(st, USER, V, 'PV', { mode: 'auto', cap: '20000', version: 1 })).toMatchObject({ mode: 'auto', cap: '20000.00', version: 2 });
    expect(st.audit.at(-1)).toMatchObject({ command: 'agent.policy.update', target: 'PV', before: { mode: 'auto', cap: '50000.00' }, after: { mode: 'auto', cap: '20000.00' } });
    expect(code(() => setPolicy(st, USER, V, 'PV', { mode: 'off', cap: '20000.00', version: 1 }))).toBe('record.version_conflict');
    expect(code(() => setPolicy(st, AGENT, V, 'PV', { mode: 'off', cap: '20000.00', version: 2 }))).toBe('agent.forbidden_setting');
    expect(policyOf(st, V, 'PV').mode).toBe('auto');
    const r = await call('PUT', '/connect/policy/PV', { mode: 'off', cap: '1.00', version: 1 }, true);
    expect({ s: r.status, c: (await r.json() as { code: string }).code }).toEqual({ s: 403, c: 'agent.forbidden_setting' });
    const bad = await call('PUT', '/connect/policy/TI', { mode: 'auto', cap: '1.00', version: 1 });
    expect({ s: bad.status, c: (await bad.json() as { code: string }).code }).toEqual({ s: 422, c: 'agent.policy_t_class' });
    const bad2 = await call('PUT', '/connect/policy/PV', { mode: 'sometimes', cap: '-1', version: 1 });
    expect(bad2.status).toBe(422);
    expect(Object.keys((await bad2.json() as { fieldErrors: object }).fieldErrors).sort()).toEqual(['cap', 'mode']);
  });
});

describe('ruling 5: connected apps and the consent screen', () => {
  it('lists the connected apps of the company and revokes one', () => {
    const st = seed();
    expect(listApps(st, V).map((a) => a.name)).toEqual(['Claude Desktop']);
    expect(listApps(st, N)).toEqual([]);
    const a = listApps(st, V)[0];
    expect(revokeApp(st, USER, V, a.id, a.version).revokedAt).toBeTruthy();
    expect(listApps(st, V)).toEqual([]);
    expect(st.audit.at(-1)).toMatchObject({ command: 'connect.oauth.revoke' });
  });
  it('consent shows the company and the owner\'s rights; approve connects with requested ∩ owner (never more); deny connects nothing', () => {
    const st = seed();
    const info = consentInfo(st, V, OWNER, 'cl-assistant');
    expect(info).toMatchObject({ client: { name: 'ผู้ช่วยบัญชี (AI)' }, company: { id: V }, owner: { name: USER.name } });
    expect(info.requested).toContain('settings.manage');
    expect(info.granted).not.toContain('settings.manage'); // a §8.5 right is never granted
    expect(info.granted).toContain('doc.TI.create'); // the accountant holds it
    expect(consentInfo(st, V, { ...OWNER, perms: PERMISSIONS_BY_ROLE.operator }, 'cl-assistant').granted).not.toContain('report.read');
    expect(decideConsent(st, USER, V, OWNER, 'cl-assistant', 'deny')).toEqual({ status: 'denied' });
    expect(listApps(st, V)).toHaveLength(1);
    const ok = decideConsent(st, USER, V, OWNER, 'cl-assistant', 'approve');
    expect(listApps(st, V).find((a) => a.id === ok.appId)?.scopes).toEqual(info.granted);
    expect(code(() => consentInfo(st, V, OWNER, 'cl-nope'))).toBe('oauth.client_unknown');
    expect(code(() => decideConsent(st, AGENT, V, OWNER, 'cl-assistant', 'approve'))).toBe('agent.forbidden_setting');
  });
  it('over the wire: the consent info and the approval work for the administrator', async () => {
    const info = await (await call('GET', '/oauth/consent-info?client=cl-assistant')).json() as { granted: string[]; company: { name: string } };
    expect(info.company.name).toBeTruthy();
    expect(info.granted).not.toContain('doc.TI.create'); // the administrator holds no TI right
    expect((await call('POST', '/oauth/consent', { client: 'cl-assistant', decision: 'approve' })).status).toBe(200);
    expect((await (await call('GET', '/connect/apps')).json() as { items: unknown[] }).items).toHaveLength(2);
  });
});
