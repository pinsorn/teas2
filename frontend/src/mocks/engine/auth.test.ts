import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AGENT, USER } from '../fixtures/documents';
import { FIXTURE_PREDICATES } from '../fixtures/ids';
import { setSession, setSettings } from '../settings';
import { buildSeedState, loadState, resetState } from '../store';
import { testServer } from '../test-server';
import { cancel } from './commands';
import { checkInvariants } from './invariants';
import { MockError } from './log';
import { DEMO, FIXTURE_TOKENS, changePassword, demoRecovery, relogin, currentSession, confirmEnrol, createPublicLink, listSessions, login, onboard, profileOf, resolvePublicLink, revokePublicLinks, revokeSession, startEnrol, verifyTotp } from './auth';

beforeAll(() => testServer.listen({ onUnhandledFrame: 'error' }));
afterEach(() => testServer.resetHandlers());
afterAll(() => testServer.close());
beforeEach(() => { localStorage.clear(); resetState(); setSettings({ companyKey: 'vat', role: 'admin', screenState: 'normal' }); });

const seed = () => buildSeedState('accountant');
const fail = (f: () => unknown): MockError => { try { f(); } catch (e) { return e as MockError; } throw new Error('did not throw'); };
const call = (method: string, path: string, body?: unknown, agent = false) =>
  fetch(`http://localhost/bff/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(agent ? { 'x-teas-actor': 'agent' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });

describe('ruling 1: login behaves like the contract', () => {
  it('state version 63 and the seed holds', () => {
    const st = seed();
    expect(st.version).toBe(63);
    expect(checkInvariants(st)).toEqual([]);
  });
  it('a wrong password and an unknown email give the SAME refusal, naming no field', () => {
    const st = seed();
    const a = fail(() => login(st, DEMO.email, 'wrong-Password1'));
    const b = fail(() => login(st, 'nobody@example.com', 'wrong-Password1'));
    expect({ s: a.status, c: a.code, m: a.title }).toEqual({ s: b.status, c: b.code, m: b.title });
    expect(a.status).toBe(401);
    expect(a.title).toBe('อีเมลหรือรหัสผ่านไม่ถูกต้อง');
  });
  it('the fifth consecutive failure locks the account (even for the right password, and for an unknown email); a success resets the counter', () => {
    const st = seed();
    for (let i = 0; i < 4; i++) fail(() => login(st, DEMO.email, `bad-${i}`));
    expect(login(st, DEMO.email, DEMO.password).status).toBe('ok'); // counter reset
    for (let i = 0; i < 5; i++) fail(() => login(st, DEMO.email, `bad-${i}`));
    const locked = fail(() => login(st, DEMO.email, DEMO.password));
    expect(locked.status).toBe(429);
    expect(locked.code).toBe('auth.locked');
    for (let i = 0; i < 5; i++) fail(() => login(st, 'ghost@example.com', 'x'));
    expect(fail(() => login(st, 'ghost@example.com', 'x')).code).toBe('auth.locked'); // an unknown email behaves the same
  });
  it('passwords and TOTP secrets are stored as hashes only; no credential reaches the audit log', () => {
    const st = seed();
    const s = JSON.stringify(st);
    expect(s).not.toContain(DEMO.password);
    expect(s).not.toContain(DEMO.secret);
    for (const r of DEMO.recovery) expect(s).not.toContain(r);
    login(st, DEMO.email, DEMO.password);
    expect(JSON.stringify(st.audit)).not.toContain(DEMO.password);
  });
});

describe('TOTP step and recovery codes', () => {
  it('a TOTP user gets a challenge, not a session; a wrong code is refused with the TOTP message; the right one signs in; the challenge is single-use', () => {
    const st = seed();
    const r = login(st, DEMO.totpEmail, DEMO.totpPassword);
    expect(r.status).toBe('totp_required');
    if (r.status !== 'totp_required') return;
    const bad = fail(() => verifyTotp(st, r.challenge, { code: '000000' }));
    expect(bad.code).toBe('auth.totp_invalid');
    expect(bad.title).toBe('รหัสยืนยันไม่ถูกต้อง');
    expect(verifyTotp(st, r.challenge, { code: DEMO.totpCode }).sessionId).toBeTruthy();
    expect(fail(() => verifyTotp(st, r.challenge, { code: DEMO.totpCode })).code).toBe('auth.challenge_invalid');
  });
  it('a recovery code works once', () => {
    const st = seed();
    const go = () => { const r = login(st, DEMO.totpEmail, DEMO.totpPassword); if (r.status !== 'totp_required') throw new Error('x'); return r.challenge; };
    expect(verifyTotp(st, go(), { recoveryCode: DEMO.recovery[0] }).sessionId).toBeTruthy();
    expect(fail(() => verifyTotp(st, go(), { recoveryCode: DEMO.recovery[0] })).code).toBe('auth.totp_invalid');
    expect(verifyTotp(st, go(), { recoveryCode: DEMO.recovery[1] }).sessionId).toBeTruthy();
  });
  it('wrong codes count towards the same lockout', () => {
    const st = seed();
    for (let i = 0; i < 5; i++) { const r = login(st, DEMO.totpEmail, DEMO.totpPassword); if (r.status === 'totp_required') fail(() => verifyTotp(st, r.challenge, { code: '111111' })); else break; }
    expect(fail(() => login(st, DEMO.totpEmail, DEMO.totpPassword)).code).toBe('auth.locked');
  });
  it('enrolment: the secret is shown at start, kept as a hash; recovery codes are returned ONCE by the confirming call and no read returns them', () => {
    const st = seed();
    const { secret } = startEnrol(st, USER, 'u-1');
    expect(JSON.stringify(st)).not.toContain(secret);
    expect(fail(() => confirmEnrol(st, USER, 'u-1', '000000')).code).toBe('auth.totp_invalid');
    const { recoveryCodes } = confirmEnrol(st, USER, 'u-1', DEMO.totpCode);
    expect(recoveryCodes).toHaveLength(8);
    const s = JSON.stringify(st);
    for (const c of recoveryCodes) expect(s).not.toContain(c);
    expect(JSON.stringify(profileOf(st, 'u-1'))).not.toMatch(new RegExp(recoveryCodes[0]));
    expect(profileOf(st, 'u-1')).toMatchObject({ totpEnabled: true, recoveryRemaining: 8 });
    expect(fail(() => confirmEnrol(st, USER, 'u-1', DEMO.totpCode)).code).toBe('auth.enrol_not_started'); // nothing pending: the codes cannot be had a second time
    expect(JSON.stringify(st.audit.filter((a) => a.command.startsWith('auth.')))).not.toContain(recoveryCodes[0]);
  });
});

describe('profile: password and sessions', () => {
  it('a wrong current password gets the same generic style; a weak or unconfirmed new one is refused; success stores a new hash and ends the other sessions', () => {
    const st = seed();
    expect(fail(() => changePassword(st, USER, 'u-1', { current: 'nope', next: 'Newpass#2026x', confirm: 'Newpass#2026x' })).message).toContain('รหัสผ่านปัจจุบันไม่ถูกต้อง');
    expect(fail(() => changePassword(st, USER, 'u-1', { current: DEMO.password, next: 'short', confirm: 'short' })).code).toBe('auth.password_weak');
    expect(fail(() => changePassword(st, USER, 'u-1', { current: DEMO.password, next: 'Newpass#2026x', confirm: 'Different#2026x' })).code).toBe('auth.password_mismatch');
    expect(listSessions(st, 'u-1').length).toBeGreaterThan(1);
    changePassword(st, USER, 'u-1', { current: DEMO.password, next: 'Newpass#2026x', confirm: 'Newpass#2026x' });
    expect(listSessions(st, 'u-1')).toHaveLength(1);
    expect(fail(() => login(st, DEMO.email, DEMO.password)).code).toBe('auth.invalid_credentials');
    expect(login(st, DEMO.email, 'Newpass#2026x').status).toBe('ok');
    expect(JSON.stringify(st)).not.toContain('Newpass#2026x');
    expect(st.audit.at(-1)?.command).toBe('auth.login');
    expect(JSON.stringify(st.audit)).not.toContain('Newpass');
  });
  it('sessions: the current one is marked; revoking another keeps you in; revoking the current one signs out', () => {
    const st = seed();
    const rows = listSessions(st, 'u-1');
    const cur = rows.find((r) => r.current)!, other = rows.find((r) => !r.current)!;
    expect(revokeSession(st, USER, 'u-1', other.id).signedOut).toBe(false);
    expect(listSessions(st, 'u-1').some((r) => r.id === other.id)).toBe(false);
    expect(revokeSession(st, USER, 'u-1', cur.id).signedOut).toBe(true);
    expect(fail(() => revokeSession(st, USER, 'u-1', 'ses-nope')).status).toBe(404);
  });
});

describe('ruling 5: public links', () => {
  const issued = (st: ReturnType<typeof seed>) => st.docs.find((d) => FIXTURE_PREDICATES.tiIssuedUnpaid(d, st))!;
  it('the fixture tokens (TI issued unpaid, QT issued) resolve to their document; an unknown token resolves to nothing', () => {
    const st = seed();
    expect(resolvePublicLink(st, FIXTURE_TOKENS.ti)?.doc.id).toBe(issued(st).id);
    expect(resolvePublicLink(st, FIXTURE_TOKENS.qt)?.doc.type).toBe('QT');
    expect(resolvePublicLink(st, 'nope')).toBeUndefined();
  });
  it('a made token is random, not derived from the document id, and the state keeps only a hash', () => {
    const st = seed();
    const d = issued(st);
    const a = createPublicLink(st, USER, d.companyId, d.id), b = createPublicLink(st, USER, d.companyId, d.id);
    expect(a.token).not.toBe(b.token);
    expect(a.token).toMatch(/^[0-9a-f]{40}$/);
    expect(a.token).not.toContain(d.id);
    expect(JSON.stringify(st)).not.toContain(a.token);
    expect(JSON.stringify(st.audit)).not.toContain(a.token);
    expect(resolvePublicLink(st, a.token)?.doc.id).toBe(d.id);
  });
  it('no link for a draft; revoking ends every link of the document', () => {
    const st = seed();
    const draft = st.docs.find((d) => d.status === 'draft' && d.type === 'TI')!;
    expect(fail(() => createPublicLink(st, USER, draft.companyId, draft.id)).code).toBe('public.not_issued');
    expect(revokePublicLinks(st, USER, issued(st).companyId, issued(st).id)).toBeGreaterThan(0);
    expect(resolvePublicLink(st, FIXTURE_TOKENS.ti)).toBeUndefined(); // revoked: a revoked token renders nothing
  });
  it('cancelling the document (the real command) ends its tokens', () => {
    const st = seed();
    const d = issued(st);
    const { token } = createPublicLink(st, USER, d.companyId, d.id);
    expect(resolvePublicLink(st, token)).toBeTruthy();
    cancel(st, d.id, d.version, 'OTHER', 'ทดสอบ', USER);
    expect(resolvePublicLink(st, token)).toBeUndefined();
    expect(resolvePublicLink(st, FIXTURE_TOKENS.ti)).toBeUndefined();
  });
  it('an agent can neither make nor revoke a link', () => {
    const st = seed();
    const d = issued(st);
    expect(fail(() => createPublicLink(st, AGENT, d.companyId, d.id)).code).toBe('agent.forbidden_setting');
    expect(fail(() => revokePublicLinks(st, AGENT, d.companyId, d.id)).code).toBe('agent.forbidden_setting');
  });
});

describe('ruling 2: onboarding creates co-new through the company / bank commands', () => {
  const body = { legalNameTh: 'บริษัท ตัวอย่างใหม่ จำกัด', taxId: '0105569056784', branchCode: '00000', address: '1 ถนนทดสอบ กรุงเทพมหานคร 10110', vatRegistered: false, fiscalYearStartMonth: 1,
    template: 'sme-th', bank: { kind: 'bank', accountName: 'กสิกรไทย กระแสรายวัน', bankName: 'kbank', accountNo: '999-9-99999-9' }, cutoff: '2026-09-30' };
  it('refuses a bad TIN and a non-January fiscal year start, writing nothing', () => {
    const st = seed();
    const before = JSON.stringify(st);
    expect(fail(() => onboard(st, USER, { ...body, taxId: '0105569056780' })).code).toBe('record.invalid');
    expect(fail(() => onboard(st, USER, { ...body, fiscalYearStartMonth: 4 })).code).toBe('company.fiscal_year_unsupported');
    expect(fail(() => onboard(st, USER, { ...body, bank: { ...body.bank, accountNo: 'abc' } })).code).toBe('record.invalid');
    expect(JSON.stringify(st)).toBe(before);
  });
  it('creates the company with its chart, bank account, membership and an audit row; the books balance; a second run is refused', () => {
    const st = seed();
    const r = onboard(st, USER, body);
    expect(r).toMatchObject({ companyId: 'co-new', cutoff: '2026-09-30' });
    expect(st.companies.find((c) => c.id === 'co-new')).toMatchObject({ legalNameTh: body.legalNameTh, vatRegistered: false, fiscalYearStartMonth: 1 });
    expect(st.accounts.some((a) => a.companyId === 'co-new' && a.code === '1121')).toBe(true);
    expect(st.bankAccounts.filter((b) => b.companyId === 'co-new')).toHaveLength(1);
    expect(st.memberships.some((m) => m.companyId === 'co-new' && m.role === 'admin')).toBe(true);
    expect(st.audit.at(-1)).toMatchObject({ command: 'company.create', target: 'co-new', companyId: 'co-new' });
    expect(checkInvariants(st)).toEqual([]);
    expect(fail(() => onboard(st, USER, body)).code).toBe('company.exists');
  });
  it('an agent cannot onboard', () => {
    expect(fail(() => onboard(seed(), AGENT, body)).code).toBe('agent.forbidden_setting');
  });
});

describe('every new route stays outside the agent allowlist (wiki: Agent requests)', () => {
  const routes: [string, string, unknown?][] = [
    ['POST', '/auth/login', { email: DEMO.email, password: DEMO.password }], ['POST', '/auth/totp', { challenge: 'x', code: '1' }], ['POST', '/auth/logout'], ['POST', '/auth/relogin', { password: 'x' }],
    ['POST', '/auth/session/extend'], ['POST', '/auth/password', {}], ['POST', '/auth/totp/enrol', {}], ['POST', '/auth/totp/enrol/verify', { code: '1' }], ['POST', '/auth/sessions/ses-2/revoke'],
    ['POST', '/onboarding', {}], ['POST', '/docs/TI/x/public-links'], ['DELETE', '/docs/TI/x/public-links'],
    ['GET', '/auth/session'], ['GET', '/auth/profile'], ['GET', '/auth/sessions'], ['GET', '/docs/TI/x/public-links'],
  ];
  it.each(routes)('an agent calling %s %s is refused (403) and nothing is written', async (method, path, body) => {
    const before = localStorage.getItem('teas2.mock.state.v26');
    const r = await call(method, path, body, true);
    expect(r.status).toBe(403);
    expect(localStorage.getItem('teas2.mock.state.v26')).toBe(before);
  });
  it('the public read is open and answers one thing for an unknown and for a revoked token', async () => {
    const st = loadState();
    const d = st.docs.find((x) => FIXTURE_PREDICATES.tiIssuedUnpaid(x, st))!;
    expect((await call('POST', `/docs/TI/${d.id}/public-links`)).status).toBe(403); // the administrator holds no doc.TI.read
    expect((await call('DELETE', `/docs/TI/${d.id}/public-links`)).status).toBe(403);
    setSettings({ role: 'accountant' });
    const ok = await call('GET', `/public/p/${FIXTURE_TOKENS.ti}`);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ type: 'TI', paper: { number: d.number } });
    const unknown = await call('GET', '/public/p/nope');
    expect(unknown.status).toBe(404);
    expect((await call('DELETE', `/docs/TI/${d.id}/public-links`)).status).toBe(200);
    const revoked = await call('GET', `/public/p/${FIXTURE_TOKENS.ti}`);
    expect(revoked.status).toBe(404);
    expect(await revoked.json()).toEqual(await unknown.json());
  });
});

// ---------------------------------------------------------------- HC3a (Opus review round 1)
describe('HC3a B1: the session gate open set is an exact method + path list', () => {
  const GATE = ['auth.session_expired', 'auth.unauthenticated'];
  const code = async (method: string, path: string, body?: unknown) => ((await (await call(method, path, method === 'GET' ? undefined : body)).json().catch(() => ({}))) as { code?: string }).code;
  // [method, path, gated?]: gated = an expired / signed-out session gets the gate's 401
  const table: [string, string, boolean][] = [
    ['POST', '/auth/login', false], ['POST', '/auth/totp', false], ['POST', '/auth/relogin', false], ['GET', '/auth/session', false], ['POST', '/auth/logout', false], ['GET', '/auth/demo', false], ['GET', '/public/p/nope', false],
    ['POST', '/auth/totp/enrol', true], ['POST', '/auth/totp/enrol/verify', true], ['GET', '/auth/sessions', true], ['POST', '/auth/sessions/ses-2/revoke', true], ['POST', '/auth/session/extend', true],
    ['GET', '/auth/profile', true], ['POST', '/auth/password', true], ['POST', '/onboarding', true], ['GET', '/docs/TI/x/public-links', true], ['POST', '/docs/TI/x/public-links', true], ['DELETE', '/docs/TI/x/public-links', true],
    ['GET', '/me', true], ['GET', '/auth/sessionx', true], ['GET', '/auth/login', true], ['POST', '/auth/demo', true], ['POST', '/public/p/nope', true],
  ];
  for (const state of ['expired', 'out'] as const) {
    it.each(table)(`${state}: %s %s`, async (method, path, gated) => {
      setSession(state);
      const c = await code(method, path, {});
      if (gated) expect(c).toBe(state === 'out' ? 'auth.unauthenticated' : 'auth.session_expired');
      else if (path === '/auth/relogin') expect(c).toBe(state === 'out' ? 'auth.unauthenticated' : 'auth.invalid_credentials'); // the handler's own answer, not the gate's
      else expect(GATE).not.toContain(c);
    });
  }
  const real = table.filter(([m, p]) => !(p === '/auth/sessionx' || (m === 'GET' && p === '/auth/login') || (m === 'POST' && (p === '/auth/demo' || p.startsWith('/public/'))))); // routes nobody handles
  it.each(real)('expiring behaves like active: %s %s is never the gate 401', async (method, path) => {
    setSession('expiring');
    expect(GATE).not.toContain(await code(method, path, {}));
  });
  it('signed out: enrolment, the sessions list / revoke and extend are all 401 and nothing is written', async () => {
    setSession('out');
    const before = localStorage.getItem('teas2.mock.state.v26');
    for (const [m, p] of [['POST', '/auth/totp/enrol'], ['POST', '/auth/totp/enrol/verify'], ['GET', '/auth/sessions'], ['POST', '/auth/sessions/ses-2/revoke'], ['POST', '/auth/session/extend']]) expect((await call(m, p, m === 'GET' ? undefined : {})).status).toBe(401);
    expect(localStorage.getItem('teas2.mock.state.v26')).toBe(before);
  });
});

describe('HC3a M1 / M2: extend and re-login', () => {
  it('extend works from expiring and active only', async () => {
    setSession('expiring');
    expect((await call('POST', '/auth/session/extend')).status).toBe(200);
    setSession('expired');
    expect((await call('POST', '/auth/session/extend')).status).toBe(401);
  });
  it('relogin only from expired: out is 401, expiring is refused, an expired one works with the password', async () => {
    setSession('out');
    expect((await call('POST', '/auth/relogin', { password: DEMO.password })).status).toBe(401);
    setSession('expiring');
    expect((await call('POST', '/auth/relogin', { password: DEMO.password })).status).toBe(409);
    setSession('expired');
    expect((await call('POST', '/auth/relogin', { password: 'wrong' })).status).toBe(401);
    const r = await call('POST', '/auth/relogin', { password: DEMO.password });
    expect(await r.json()).toEqual({ status: 'ok' });
    expect((await call('GET', '/auth/profile')).status).toBe(200); // the gate is open again
  });
  it('relogin ends the old session row, opens a new one and audits a login; there is no fallback user', () => {
    const st = seed();
    const old = currentSession(st)!;
    expect(relogin(st, DEMO.password)).toEqual({ status: 'ok' });
    expect(old.revokedAt).toBeTruthy();
    expect(currentSession(st)!.id).not.toBe(old.id);
    expect(st.audit.at(-1)).toMatchObject({ command: 'auth.login', target: 'u-1' });
    expect(fail(() => relogin(st, 'nope')).code).toBe('auth.invalid_credentials');
    st.auth!.current = '';
    expect(fail(() => relogin(st, DEMO.password)).code).toBe('auth.unauthenticated'); // nobody is signed in: u-1 is not assumed
  });
  it('a TOTP user repeats the second factor at re-login; a wrong code and each recovery code behave as at sign-in', () => {
    const st = seed();
    const r = login(st, DEMO.totpEmail, DEMO.totpPassword);
    if (r.status !== 'totp_required') throw new Error('x');
    verifyTotp(st, r.challenge, { code: DEMO.totpCode });
    expect(relogin(st, DEMO.totpPassword)).toEqual({ status: 'totp_required' }); // the password alone does not re-open the session
    const held = currentSession(st)!;
    expect(fail(() => relogin(st, DEMO.totpPassword, { code: '000000' })).code).toBe('auth.totp_invalid');
    expect(currentSession(st)!.id).toBe(held.id);
    expect(relogin(st, DEMO.totpPassword, { recoveryCode: DEMO.recovery[0] })).toEqual({ status: 'ok' });
    expect(currentSession(st)!.id).not.toBe(held.id);
    expect(fail(() => relogin(st, DEMO.totpPassword, { recoveryCode: DEMO.recovery[0] })).code).toBe('auth.totp_invalid'); // each recovery code once
  });
});

describe('HC3a M3 / M4: public links', () => {
  it('GET / DELETE check the document type in the URL like POST', async () => {
    setSettings({ role: 'accountant' });
    const st = loadState();
    const ti = st.docs.find((x) => FIXTURE_PREDICATES.tiIssuedUnpaid(x, st))!;
    expect((await call('GET', `/docs/QT/${ti.id}/public-links`)).status).toBe(404);
    expect((await call('POST', `/docs/QT/${ti.id}/public-links`)).status).toBe(404);
    expect((await call('DELETE', `/docs/QT/${ti.id}/public-links`)).status).toBe(404);
    expect(resolvePublicLink(loadState(), FIXTURE_TOKENS.ti)).toBeTruthy(); // the QT right did not revoke a TI link
    expect((await call('GET', `/docs/TI/${ti.id}/public-links`)).status).toBe(200);
  });
  it('only documents that go to a counterparty get a link: PR, JV, EX, PV, PB and the like are refused in the engine', () => {
    const st = seed();
    let refused = 0;
    for (const type of ['PR', 'JV', 'EX', 'PV', 'PB', 'PCN', 'PDN', 'OB', 'FA', 'DP'] as const) {
      const d = st.docs.find((x) => x.type === type && ['issued', 'partly_settled', 'settled'].includes(x.status));
      if (!d) continue;
      expect(fail(() => createPublicLink(st, USER, d.companyId, d.id)).code, type).toMatch(/^public\.(not_shareable|not_printable)$/);
      refused++;
    }
    expect(refused).toBeGreaterThan(2);
    const pr = st.docs.find((x) => x.type === 'PR' && ['issued', 'settled'].includes(x.status))!;
    expect(fail(() => createPublicLink(st, USER, pr.companyId, pr.id)).code).toBe('public.not_shareable');
  });
});

describe('HC3a minors', () => {
  it('m3: the fifth consecutive failure itself answers "locked" - sign-in and TOTP', () => {
    const st = seed();
    for (let i = 0; i < 4; i++) expect(fail(() => login(st, DEMO.email, `x${i}`)).code).toBe('auth.invalid_credentials');
    expect(fail(() => login(st, DEMO.email, 'x5')).code).toBe('auth.locked');
    const s2 = seed();
    for (let i = 0; i < 4; i++) { const r = login(s2, DEMO.totpEmail, DEMO.totpPassword); if (r.status === 'totp_required') expect(fail(() => verifyTotp(s2, r.challenge, { code: '111111' })).code).toBe('auth.totp_invalid'); }
    const r = login(s2, DEMO.totpEmail, DEMO.totpPassword);
    if (r.status !== 'totp_required') throw new Error('x');
    expect(fail(() => verifyTotp(s2, r.challenge, { code: '111111' })).code).toBe('auth.locked');
  });
  it('m1: auth events are audited in the company the user is working in', () => {
    const st = seed();
    setSettings({ companyKey: 'nonvat' });
    login(st, DEMO.email, DEMO.password);
    expect(st.audit.at(-1)).toMatchObject({ command: 'auth.login', companyId: 'co-nonvat' });
    changePassword(st, USER, 'u-1', { current: DEMO.password, next: 'Newpass#2026x', confirm: 'Newpass#2026x' });
    expect(st.audit.at(-1)).toMatchObject({ command: 'auth.password.change', companyId: 'co-nonvat' });
  });
  it('m2: the administrator of the new company is the acting user', () => {
    const st = seed();
    const who = { kind: 'user' as const, id: 'usr-vat-2', name: 'wichai' };
    onboard(st, who, { legalNameTh: 'บริษัท ตัวอย่างใหม่ จำกัด', taxId: '0105569056784', branchCode: '00000', address: '1 ถนนทดสอบ', vatRegistered: false, fiscalYearStartMonth: 1, template: 'sme-th', bank: { kind: 'cash', accountName: 'เงินสดย่อย' }, cutoff: '2026-09-30' });
    expect(st.memberships.filter((m) => m.companyId === 'co-new')).toEqual([expect.objectContaining({ userId: 'usr-vat-2', role: 'admin' })]);
    expect(st.staff.find((m) => m.companyId === 'co-new')).toMatchObject({ userId: 'usr-vat-2', email: DEMO.totpEmail });
  });
  it('m5: /auth/demo offers a recovery code that is still unused', () => {
    const st = seed();
    expect(demoRecovery(st)).toBe(DEMO.recovery[0]);
    const r = login(st, DEMO.totpEmail, DEMO.totpPassword);
    if (r.status !== 'totp_required') throw new Error('x');
    verifyTotp(st, r.challenge, { recoveryCode: DEMO.recovery[0] });
    expect(demoRecovery(st)).toBe(DEMO.recovery[1]);
  });
});

describe('HC3b: GET /auth/session names nobody unless a live session exists', () => {
  const read = async () => (await call('GET', '/auth/session')).json() as Promise<{ state: string; email?: string }>;
  it('active / expiring / expired carry the email; the toolbar signed-out state and a real logout carry none', async () => {
    for (const state of ['active', 'expiring', 'expired'] as const) { setSession(state); expect(await read()).toMatchObject({ state, email: DEMO.email }); }
    setSession('out');
    expect(await read()).toEqual({ state: 'out' }); // a live session row exists, but the browser says signed out
    setSession('active');
    expect((await call('POST', '/auth/logout')).status).toBe(200); // a real logout: the handler also sets `out`; force the state back to prove the missing session alone is enough
    setSession('active');
    expect(await read()).toEqual({ state: 'active' });
  });
});
