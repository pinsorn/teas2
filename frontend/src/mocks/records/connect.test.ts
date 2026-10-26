import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AGENT, USER } from '../fixtures/documents';
import { permissionsOf } from '../permissions';
import { setSettings } from '../settings';
import { buildSeedState, loadState, resetState } from '../store';
import { testServer } from '../test-server';
import { AGENT_ALLOWED } from '../handlers/me';
import { createKey, rotateKey, revokeKey, authenticateKey, rightsOf, appRights, setPolicy, policyView, policyOf, listKeys, listApps, revokeApp, consentInfo, decideConsent } from './connect';

beforeAll(() => testServer.listen({ onUnhandledFrame: 'error' }));
afterEach(() => testServer.resetHandlers());
afterAll(() => testServer.close());
beforeEach(() => { localStorage.clear(); resetState(); setSettings({ companyKey: 'vat', role: 'admin', screenState: 'normal' }); });

const V = 'co-vat', N = 'co-nonvat';
const OWNER = { id: 'u-1', name: USER.name }; // the owner's rights are read from ONE place: the signed-in user's toolbar role (the tests set it)
const as = (role: 'operator' | 'accountant' | 'admin') => setSettings({ companyKey: 'vat', role, screenState: 'normal' });
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
    expect({ s: r.status, c: (await r.json() as { code: string }).code }).toEqual({ s: 403, c: 'agent.forbidden_action' });
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
    as('operator');
    expect(code(() => createKey(st, USER, V, OWNER, { name: 'x', kind: 'rest', scopes: ['report.read'] }))).toBe('connect.scope_exceeds'); // the operator holds no report.read
    as('admin');
    expect(code(() => createKey(st, USER, V, OWNER, { name: 'x', kind: 'rest', scopes: ['settings.manage'] }))).toBe('connect.scope_forbidden');
    as('accountant'); // the accountant HOLDS these, and still no key may carry them (M1): approve, cancel, correct of any type
    for (const sc of ['doc.TI.approve', 'doc.PV.approve', 'doc.TI.cancel', 'doc.PB.correct', 'doc.EX.approve', 'ledger.period.close', 'tax.filing.finalize']) expect([sc, code(() => createKey(st, USER, V, OWNER, { name: 'x', kind: 'rest', scopes: [sc] }))]).toEqual([sc, 'connect.scope_forbidden']);
    expect(createKey(st, USER, V, OWNER, { name: 'ok', kind: 'rest', scopes: ['doc.TI.create', 'doc.TI.issue', 'doc.TI.read'] }).key.scopeCount).toBe(3);
    st.apiKeys!.pop(); st.audit.pop();
    expect({ keys: st.apiKeys!.length, audit: st.audit.length }).toEqual({ keys: n, audit: a }); // a refusal writes nothing
  });
  it('at USE the key holds scopes ∩ the owner\'s CURRENT rights: a demoted or deactivated owner\'s key loses them', () => {
    const st = seed();
    const k = createKey(st, USER, V, OWNER, { name: 'x', kind: 'rest', scopes: ['report.read', 'party.read'] });
    expect(authenticateKey(st, k.secret, V).rights.sort()).toEqual(['party.read', 'report.read']);
    const me = st.staff.find((m) => m.companyId === V && m.userId === 'u-1')!;
    as('operator'); // demoted: the operator holds party.read but not report.read
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
  it('the policy needs connect.manage; a member reaches their own keys, their apps and the consent page', async () => {
    for (const role of ['accountant', 'operator'] as const) {
      as(role);
      for (const p of ['/connect/policy']) expect([role, p, (await call('GET', p)).status]).toEqual([role, p, 403]);
      for (const p of ['/connect/keys', '/connect/apps', '/oauth/consent-info?client=cl-assistant']) expect([role, p, (await call('GET', p)).status]).toEqual([role, p, 200]);
      expect([role, (await call('PUT', '/connect/policy/PV', { mode: 'off', cap: '1.00', version: 1 })).status]).toEqual([role, 403]);
    }
  });
  it('M3: a member makes, sees, rotates and revokes THEIR keys only; the manager sees everyone\'s', async () => {
    const st = seed();
    as('accountant');
    const mine = createKey(st, USER, V, OWNER, { name: 'mine', kind: 'rest', scopes: ['doc.TI.read'] }); // the ceiling is the member\'s own rights
    st.apiKeys!.push({ ...st.apiKeys!.find((k) => k.id === mine.key.id)!, id: 'key-other', name: 'theirs', ownerId: 'u-9', ownerName: 'คนอื่น' });
    expect(listKeys(st, V, 'u-1').map((k) => k.name).sort()).toEqual(['mine', 'ผู้ช่วยบัญชี (MCP)', 'ระบบรายงานภายนอก']);
    expect(listKeys(st, V).map((k) => k.name)).toContain('theirs');
    expect(code(() => revokeKey(st, USER, V, 'key-other', 1, 'u-1'))).toBe('record.not_found');
    // N2, the escalation probe: the manager (not the owner) asks to rotate a member's key to get a secret with that member's rights
    expect(code(() => rotateKey(st, USER, V, 'key-other', 1))).toBe('record.not_found');
    expect(st.apiKeys!.filter((k) => k.name === 'theirs')).toHaveLength(1); // no new key was made
    expect(st.audit.some((a) => a.command === 'connect.key.rotate')).toBe(false);
    expect(revokeKey(st, USER, V, 'key-other', 1).revokedAt).toBeTruthy(); // the manager may
  });
  it('m1: rotate is refused for an expired key and for a key whose owner is no longer active', () => {
    const st = seed();
    const k = createKey(st, USER, V, OWNER, { name: 'x', kind: 'rest', scopes: ['report.read'], expiresAt: '2026-12-31' });
    st.apiKeys!.find((x) => x.id === k.key.id)!.expiresAt = '2026-10-01';
    expect(code(() => rotateKey(st, USER, V, k.key.id, k.key.version))).toBe('connect.key_expired');
    const j = createKey(st, USER, V, OWNER, { name: 'y', kind: 'rest', scopes: ['report.read'] });
    st.staff.find((m) => m.companyId === V && m.userId === 'u-1')!.active = false;
    expect(code(() => rotateKey(st, USER, V, j.key.id, j.key.version))).toBe('connect.owner_inactive');
    expect(code(() => createKey(st, USER, V, OWNER, { name: 'z', kind: 'rest', scopes: ['report.read'] }))).toBe('connect.not_member');
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
  it('a T-class type can never be Auto; nothing is written on a refusal', () => {
    const st = seed();
    const n = st.audit.length;
    for (const t of ['TI', 'RC', 'CN', 'DN']) expect(code(() => setPolicy(st, USER, V, t, { mode: 'auto', cap: '1.00', version: 1 }))).toBe('agent.policy_t_class');
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
    expect({ s: r.status, c: (await r.json() as { code: string }).code }).toEqual({ s: 403, c: 'agent.forbidden_action' });
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
    as('accountant');
    const info = consentInfo(st, V, OWNER, 'cl-assistant');
    expect(info).toMatchObject({ client: { name: 'ผู้ช่วยบัญชี (AI)' }, company: { id: V }, owner: { name: USER.name } });
    expect(info.requested).toContain('settings.manage');
    expect(info.granted).not.toContain('settings.manage'); // a §8.5 right is never granted
    expect(info.granted).toContain('doc.TI.create'); // the accountant holds it
    expect(info.granted).not.toContain('doc.TI.approve'); // not even a right the accountant holds
    as('operator');
    expect(consentInfo(st, V, OWNER, 'cl-assistant').granted).not.toContain('report.read');
    as('accountant');
    expect(code(() => decideConsent(st, USER, V, OWNER, 'cl-assistant', 'deny', 'co-nonvat'))).toBe('oauth.company_mismatch'); // m2: the page showed another company
    expect(code(() => decideConsent(st, USER, V, OWNER, 'cl-assistant', 'approve'))).toBe('oauth.company_mismatch');
    expect(decideConsent(st, USER, V, OWNER, 'cl-assistant', 'deny', V)).toEqual({ status: 'denied' });
    expect(listApps(st, V)).toHaveLength(1);
    const ok = decideConsent(st, USER, V, OWNER, 'cl-assistant', 'approve', V);
    expect(listApps(st, V).find((a) => a.id === ok.appId)?.scopes).toEqual(info.granted);
    expect(code(() => consentInfo(st, V, OWNER, 'cl-nope'))).toBe('oauth.client_unknown');
    expect(code(() => decideConsent(st, AGENT, V, OWNER, 'cl-assistant', 'approve', V))).toBe('agent.forbidden_setting');
    // m3: the app holds its scopes ∩ the owner's CURRENT rights, like a key
    expect(appRights(st, V, ok.appId!).sort()).toEqual([...info.granted].sort());
    as('operator');
    expect(appRights(st, V, ok.appId!).every((c) => permissionsOf(st, V, 'operator').includes(c))).toBe(true);
    expect(appRights(st, V, ok.appId!)).not.toContain('report.read');
    st.staff.find((m) => m.companyId === V && m.userId === 'u-1')!.active = false;
    expect(appRights(st, V, ok.appId!)).toEqual([]);
  });
  it('over the wire: the consent info and the approval work for the administrator', async () => {
    const info = await (await call('GET', '/oauth/consent-info?client=cl-assistant')).json() as { granted: string[]; company: { name: string } };
    expect(info.company.name).toBeTruthy();
    expect(info.granted).not.toContain('doc.TI.create'); // the administrator holds no TI right
    expect((await call('POST', '/oauth/consent', { client: 'cl-assistant', decision: 'approve', companyId: 'co-vat' })).status).toBe(200);
    expect((await call('POST', '/oauth/consent', { client: 'cl-assistant', decision: 'approve' })).status).toBe(409); // no company shown: refused
    expect((await (await call('GET', '/connect/apps')).json() as { items: unknown[] }).items).toHaveLength(2);
  });
});

describe('HC2b n1: a member sees and revokes the apps they consented to', () => {
  it('the manager sees all; a member only their own; another member\'s app is a 404 for them', () => {
    const st = seed();
    st.oauthApps!.push({ ...st.oauthApps![0], id: 'app-9', name: 'ของคนอื่น', ownerId: 'u-9', ownerName: 'คนอื่น' });
    expect(listApps(st, V).map((a) => a.name).sort()).toEqual(['Claude Desktop', 'ของคนอื่น']);
    expect(listApps(st, V, 'u-1').map((a) => a.name)).toEqual(['Claude Desktop']);
    expect(code(() => revokeApp(st, USER, V, 'app-9', 1, 'u-1'))).toBe('record.not_found');
    expect(revokeApp(st, USER, V, 'app-1', 1, 'u-1').revokedAt).toBeTruthy();
    expect(revokeApp(st, USER, V, 'app-9', 1).revokedAt).toBeTruthy(); // the manager
  });
});

describe('HC2b n2: a report whose document is gone says so', () => {
  it('GET /agent-reports/:id answers docNowVersion 0 once the draft is deleted; the stored report is untouched', async () => {
    setSettings({ companyKey: 'vat', role: 'accountant', screenState: 'normal' });
    const st = loadState();
    const d = st.docs.find((x) => x.id === 'ti-002')!;
    const before = await (await call('GET', '/agent-reports/ar-1')).json() as { docVersion: number; docNowVersion: number };
    expect(before.docNowVersion).toBe(before.docVersion);
    expect((await call('DELETE', `/docs/TI/${d.id}?version=${d.version}`)).status).toBe(204);
    const after = await (await call('GET', '/agent-reports/ar-1')).json() as { docVersion: number; docNowVersion: number };
    expect([after.docVersion, after.docNowVersion]).toEqual([before.docVersion, 0]);
  });
});

describe('HC2b N3: the agent allowlist is ONE choke point in front of every handler', () => {
  const as_agent = (method: string, path: string, body?: unknown) => call(method, path, body, true);
  it('every non-GET handler of the mock refuses an agent (403 agent.forbidden_action) unless it is on the allowlist', async () => {
    const { handlers } = await import('../handlers');
    const rows = handlers.map((h) => (h as unknown as { info: { method: string; path: string } }).info).filter((i) => typeof i.method === 'string' && i.method.toUpperCase() !== 'GET');
    expect(rows.length).toBeGreaterThan(60); // the whole write surface is covered, not a sample
    const allowed = (m: string, p: string) => AGENT_ALLOWED.some((a) => a.method === m.toUpperCase() && a.path.test(p));
    const bad: string[] = [];
    for (const i of rows) {
      const path = i.path.replace('*/bff/v1', '').replace(/:[A-Za-z]+/g, 'x');
      if (allowed(String(i.method), path)) continue;
      const r = await as_agent(String(i.method).toUpperCase(), path, {});
      const j = await r.json() as { code?: string };
      if (r.status !== 403 || j.code !== (path.startsWith('/settings/') ? 'agent.forbidden_setting' : 'agent.forbidden_action')) bad.push(`${i.method} ${path} -> ${r.status} ${j.code}`);
    }
    expect(bad).toEqual([]);
  });
  it('the reviewer\'s commands, by name, through their endpoints', async () => {
    const table: [string, string][] = [['POST', '/settlements'], ['POST', '/bank/accounts/x/lines/x/match'], ['POST', '/docs/PR/x/pay'], ['POST', '/docs/PR/x/unpay'], ['POST', '/docs/JV/x/reverse'], ['POST', '/docs/FA/x/dispose'], ['POST', '/depreciation/runs'],
      ['POST', '/docs/TI/x/approve'], ['POST', '/docs/TI/x/cancel'], ['POST', '/docs/TI/x/submit'], ['POST', '/corrections'], ['PUT', '/settings/numbering/TI'], ['POST', '/connect/keys'], ['PUT', '/connect/policy/PV'], ['POST', '/oauth/consent']];
    for (const [m, p] of table) expect([m, p, (await as_agent(m, p, {})).status]).toEqual([m, p, 403]);
    expect((await as_agent('GET', '/connect/keys')).status).toBe(403); // the key surface is not readable by an agent either
  });
  it('what is allowed still works as an agent: create, review, issue (auto), update / delete its own draft; not a person\'s', async () => {
    setSettings({ companyKey: 'vat', role: 'accountant', screenState: 'normal' });
    const line = { id: 'l1', description: 'งานทดสอบ', qty: '1', unit: 'งาน', unitPrice: '321.00', taxCode: 'S7' };
    const made = await as_agent('POST', '/docs/QT', { header: { partyId: 'pc-01', documentDate: '2026-10-14' }, lines: [line] });
    expect(made.status).toBe(201);
    const d = await made.json() as { id: string; version: number; createdBy: { kind: string } };
    expect(d.createdBy.kind).toBe('agent');
    expect((await as_agent('POST', `/docs/QT/${d.id}/issue`, { version: d.version })).status).toBe(409); // no report yet: agent.review_required
    const rev = await as_agent('POST', `/docs/QT/${d.id}/agent-review`);
    expect([rev.status, (await rev.json() as { route: string }).route]).toEqual([201, 'auto']);
    const upd = await as_agent('PUT', `/docs/QT/${d.id}`, { header: { partyId: 'pc-01', documentDate: '2026-10-14', notes: 'x' }, lines: [line], version: d.version });
    expect(upd.status).toBe(200); // editing drops the report
    const v2 = (await upd.json() as { version: number }).version;
    expect(((await (await as_agent('POST', `/docs/QT/${d.id}/issue`, { version: v2 })).json()) as { code: string }).code).toBe('agent.review_required');
    expect((await as_agent('DELETE', `/docs/QT/${d.id}?version=${v2}`)).status).toBe(204);
    const theirs = loadState().docs.find((x) => x.type === 'TI' && x.status === 'draft' && x.createdBy.kind === 'user')!;
    expect(((await (await as_agent('PUT', `/docs/TI/${theirs.id}`, { header: theirs.header, lines: theirs.lines, version: theirs.version })).json()) as { code: string }).code).toBe('agent.forbidden_action'); // N4
    expect((await as_agent('DELETE', `/docs/TI/${theirs.id}?version=${theirs.version}`)).status).toBe(403);
    expect(loadState().docs.some((x) => x.id === theirs.id)).toBe(true);
  });
});
