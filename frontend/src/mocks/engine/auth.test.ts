import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AGENT, USER } from '../fixtures/documents';
import { FIXTURE_PREDICATES } from '../fixtures/ids';
import { setSettings } from '../settings';
import { buildSeedState, loadState, resetState } from '../store';
import { testServer } from '../test-server';
import { cancel } from './commands';
import { checkInvariants } from './invariants';
import { MockError } from './log';
import { DEMO, FIXTURE_TOKENS, changePassword, confirmEnrol, createPublicLink, listSessions, login, onboard, profileOf, resolvePublicLink, revokePublicLinks, revokeSession, startEnrol, verifyTotp } from './auth';

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
