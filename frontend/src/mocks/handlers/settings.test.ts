import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setSettings } from '../settings';
import { loadState, resetState } from '../store';
import { testServer } from '../test-server';

beforeAll(() => testServer.listen({ onUnhandledFrame: 'error' }));
afterEach(() => testServer.resetHandlers());
afterAll(() => testServer.close());
beforeEach(() => { localStorage.clear(); setSettings({ companyKey: 'vat', role: 'admin', screenState: 'normal' }); resetState(); }); // seeded under the admin toolbar: u-1 is STORED as admin

const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(`http://localhost/bff/v1${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
const json = async (r: Response) => (await r.json()) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const AGENT = { 'x-teas-actor': 'agent' };

describe('settings wire (ST1)', () => {
  it('permissions are checked on the server: company needs settings.manage, users and roles need users.manage', async () => {
    setSettings({ role: 'accountant' });
    expect((await call('GET', '/settings/companies/co-vat')).status).toBe(403);
    expect((await call('PUT', '/settings/companies/co-vat/contact', { tradeName: 'x' })).status).toBe(403);
    for (const p of ['/settings/users', '/settings/roles']) expect((await call('GET', p)).status).toBe(403);
    expect((await call('POST', '/settings/users', { name: 'x', email: 'x@y.example', roleId: 'operator' })).status).toBe(403);
    setSettings({ role: 'operator' });
    expect((await call('GET', '/settings/roles')).status).toBe(403);
    setSettings({ role: 'admin' });
    expect((await call('GET', '/settings/companies/co-vat')).status).toBe(200);
  });
  it('another company is 404: its settings, users and roles', async () => {
    expect((await call('GET', '/settings/companies/co-nonvat')).status).toBe(404);
    expect((await call('PUT', '/settings/companies/co-nonvat/contact', { tradeName: 'x' })).status).toBe(404);
    expect((await call('PUT', '/settings/users/usr-nonvat-2', { position: 'x', version: 1 })).status).toBe(404);
    expect((await call('POST', '/settings/users/usr-nonvat-2/reset-link')).status).toBe(404);
    expect((await call('DELETE', '/settings/roles/role-nonvat-1')).status).toBe(404);
  });
  it('an agent is refused 403 agent.forbidden_setting on every settings write, and the state is untouched', async () => {
    const before = JSON.stringify(loadState());
    const w: [string, string, unknown][] = [
      ['PUT', '/settings/companies/co-vat/contact', { tradeName: 'x' }], ['POST', '/settings/users', { name: 'x', email: 'x@y.example', roleId: 'operator' }],
      ['PUT', '/settings/users/usr-vat-3', { position: 'x', version: 1 }], ['POST', '/settings/users/usr-vat-3/active', { active: false, version: 1 }],
      ['POST', '/settings/users/usr-vat-3/reset-link', {}], ['POST', '/settings/roles', { name: 'x', permissions: [] }],
    ];
    for (const [m, p, b] of w) {
      const r = await call(m, p, b, AGENT);
      expect([m, p, r.status, (await json(r)).code]).toEqual([m, p, 403, 'agent.forbidden_setting']);
    }
    expect(JSON.stringify(loadState())).toBe(before);
  });
  it('invite: the link is in the 201 only; no later GET returns it; the row says pending', async () => {
    const r = await call('POST', '/settings/users', { name: 'คนใหม่', email: 'new@maliwan.example', roleId: 'operator' });
    expect(r.status).toBe(201);
    const made = await json(r);
    expect(made.link).toMatch(/\/link\//);
    const token = String(made.link).split('/').pop()!;
    for (let i = 0; i < 2; i++) {
      const text = await (await call('GET', '/settings/users')).text();
      expect(text).not.toContain(token);
      expect(text).toContain('new@maliwan.example');
    }
    expect(JSON.stringify(localStorage)).not.toContain(token);
    const reset = await json(await call('POST', '/settings/users/usr-vat-3/reset-link'));
    expect(reset.link).toMatch(/\/link\//);
    expect(await (await call('GET', '/settings/users')).text()).not.toContain(String(reset.link).split('/').pop()!);
  });
  it('the last admin: deactivating or demoting is 409 user.last_admin', async () => {
    expect((await call('POST', '/settings/users/usr-vat-2/active', { active: false, version: 1 })).status).toBe(200); // u-1 (admin under this toolbar) remains
    for (const [m, p, b] of [['POST', '/settings/users/usr-vat-1/active', { active: false, version: 1 }], ['PUT', '/settings/users/usr-vat-1', { roleId: 'operator', version: 1 }]] as const) {
      const r = await call(m, p, b);
      expect([r.status, (await json(r)).code]).toEqual([409, 'user.last_admin']);
    }
  });
  it('a custom role really restricts the user it is given to: assigned through the users route, /me and every route follow it', async () => {
    const role = await json(await call('POST', '/settings/roles', { name: 'อ่านลูกค้า', permissions: ['users.manage', 'party.read'] }));
    const me = async () => (await json(await call('GET', '/me'))).permissions as string[];
    expect(await me()).toContain('settings.manage');
    const put = await call('PUT', '/settings/users/usr-vat-1', { roleId: role.id, version: 1 });
    expect(put.status).toBe(200);
    expect(await me()).toEqual(['users.manage', 'party.read']);
    expect((await call('GET', '/settings/companies/co-vat')).status).toBe(403); // settings.manage is not held any more
    expect((await call('GET', '/records/employee')).status).toBe(403);
    expect((await call('GET', '/records/customer')).status).toBe(200); // party.read still works
    const lockout = await call('PUT', '/settings/users/usr-vat-1', { roleId: 'operator', version: 2 });
    expect([lockout.status, (await json(lockout)).code]).toEqual([409, 'user.last_admin']); // u-1 administers through the custom role: no self-demotion
  });
  it('m5: u-1 in the users list follows the toolbar role, so the self rule is demoable', async () => {
    setSettings({ role: 'accountant' });
    const row = async () => ((await json(await call('GET', '/settings/users'))).items as { id: string; roleId: string }[]).find((u) => u.id === 'usr-vat-1')!;
    // an accountant cannot list users: reseed as admin first, then flip the toolbar
    setSettings({ role: 'admin' });
    expect((await row()).roleId).toBe('admin');
    const state = loadState();
    state.staff.find((m) => m.id === 'usr-vat-1')!.roleId = 'accountant'; // a state seeded while the toolbar said accountant
    localStorage.setItem('teas2.mock.state.v26', JSON.stringify(state));
    expect((await row()).roleId).toBe('admin'); // the list shows the role the toolbar simulates
    // ST2c N2: the list is a view; the last-admin rule judges the STORED rows (u-1 is stored accountant here, usr-vat-2 is the stored admin)
    const r = await call('POST', '/settings/users/usr-vat-2/active', { active: false, version: 1 });
    expect([r.status, (await json(r)).code]).toEqual([409, 'user.last_admin']);
  });
  it('m3 wire: a company PUT without a version is 422, a stale one 409', async () => {
    expect((await call('PUT', '/settings/companies/co-vat/contact', { tradeName: 'x' })).status).toBe(422);
    expect((await call('PUT', '/settings/companies/co-vat/contact', { tradeName: 'x', version: 1 })).status).toBe(200);
    const stale = await call('PUT', '/settings/companies/co-vat/contact', { tradeName: 'y', version: 1 });
    expect([stale.status, (await json(stale)).code]).toEqual([409, 'record.version_conflict']);
  });
  it('default notes: the company page edits what a blank document starts with, per company', async () => {
    expect((await json(await call('GET', '/settings/default-notes'))).QT).toBeTruthy();
    const r = await call('PUT', '/settings/companies/co-vat/notes', { defaultNotes: { QT: 'หมายเหตุใหม่ของฉัน' }, version: 1 });
    expect(r.status).toBe(200);
    expect((await json(await call('GET', '/settings/default-notes'))).QT).toBe('หมายเหตุใหม่ของฉัน');
    setSettings({ companyKey: 'nonvat' });
    expect((await json(await call('GET', '/settings/default-notes'))).QT).not.toBe('หมายเหตุใหม่ของฉัน');
  });
  it('field errors travel as problem+json fieldErrors; a refusal does not persist', async () => {
    const r = await call('PUT', '/settings/companies/co-vat/payroll', { ssoEmployerAccountNo: '12', version: 1 });
    expect(r.status).toBe(422);
    expect((await json(r)).fieldErrors.ssoEmployerAccountNo).toHaveLength(1);
    expect(loadState().companies.find((c) => c.id === 'co-vat')!.ssoEmployerAccountNo).toBe('1234567890');
    const fy = await call('PUT', '/settings/companies/co-vat/fiscal', { fiscalYearStartMonth: 4, version: 1 });
    expect([fy.status, (await json(fy)).code]).toEqual([409, 'company.fiscal_year_locked']);
  });
});
