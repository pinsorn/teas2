import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { issue } from '../engine/commands';
import { updateCompany } from '../engine/company';
import { correctionPlan, executePlan } from '../engine/corrections';
import { PAPER_BUILDERS } from '../engine/paper';
import { AGENT, USER } from '../fixtures/documents';
import { PERMISSIONS_BY_ROLE } from '../permissions';
import { setSettings } from '../settings';
import { ctx } from '../handlers/common';
import { buildSeedState, loadState, resetState, saveState } from '../store';
import { testServer } from '../test-server';
import { createRole, updateRole } from './roles';
import { acceptInvite, inviteUser, listUsers, setUserActive, updateUser } from './users';

// ST1a: the Opus review fixes (B1 role edit, M1 pending invite, M2 I3 papers, M3 corrections under a custom role, m4, m7).
beforeAll(() => testServer.listen({ onUnhandledFrame: 'error' }));
afterEach(() => testServer.resetHandlers());
afterAll(() => testServer.close());
beforeEach(() => { localStorage.clear(); resetState(); setSettings({ companyKey: 'vat', role: 'admin', screenState: 'normal' }); });

const V = 'co-vat';
const code = (f: () => unknown) => { try { f(); } catch (e) { return (e as { message: string }).message.split(':')[0]; } return undefined; };
const seed = (role: 'operator' | 'accountant' | 'admin' = 'accountant') => buildSeedState(role);

describe('B1: editing a role cannot leave the company without an administrator', () => {
  it("the reviewer's probe: the last admin holds a custom role; dropping users.manage from it is refused and nothing changes", () => {
    const st = seed('accountant');
    const adm = createRole(st, USER, V, { name: 'ผู้ดูแลย่อย', permissions: ['users.manage'] });
    updateUser(st, USER, V, 'usr-vat-3', { roleId: adm.id, version: 1 });
    setUserActive(st, USER, V, 'usr-vat-2', false, 1); // allowed: usr-vat-3 administers
    const n = st.audit.length;
    expect(code(() => updateRole(st, USER, V, adm.id, { permissions: ['party.read'], version: 1 }))).toBe('user.last_admin');
    expect(st.roles.find((r) => r.id === adm.id)!.permissions).toEqual(['users.manage']);
    expect(st.audit.length).toBe(n);
  });
  it('another admin elsewhere makes the edit fine; editing other permissions is always fine', () => {
    const st = seed('accountant'); // usr-vat-2 is a system admin
    const adm = createRole(st, USER, V, { name: 'ผู้ดูแลย่อย', permissions: ['users.manage', 'party.read'] });
    updateUser(st, USER, V, 'usr-vat-3', { roleId: adm.id, version: 1 });
    expect(updateRole(st, USER, V, adm.id, { permissions: ['users.manage'], version: 1 }).version).toBe(2);
    expect(updateRole(st, USER, V, adm.id, { permissions: ['party.read'], version: 2 }).version).toBe(3);
  });
  it('self variant: u-1 holds a custom admin role and cannot edit users.manage out of it, even with other admins', () => {
    const st = seed('accountant');
    const adm = createRole(st, USER, V, { name: 'ผู้ดูแลของฉัน', permissions: ['users.manage', 'party.read'] });
    updateUser(st, USER, V, 'usr-vat-1', { roleId: adm.id, version: 1 }); // u-1 takes it (still administers, so allowed)
    expect(code(() => updateRole(st, USER, V, adm.id, { permissions: ['party.read'], version: 1 }))).toBe('user.last_admin');
  });
});

describe('M1: a pending invite is not an administrator', () => {
  it('invite an admin, deactivate the only real admin -> refused; accept the invite, then deactivate -> allowed', () => {
    const st = seed('accountant');
    const { row } = inviteUser(st, USER, V, { name: 'ผู้ดูแลใหม่', email: 'ghost@maliwan.example', roleId: 'admin' });
    expect(code(() => setUserActive(st, USER, V, 'usr-vat-2', false, 1))).toBe('user.last_admin');
    const accepted = acceptInvite(st, USER, V, row.id);
    expect(accepted.invitePending).toBe(false);
    expect(st.audit.at(-1)).toMatchObject({ command: 'user.accept_invite', target: row.id });
    expect(setUserActive(st, USER, V, 'usr-vat-2', false, 1).active).toBe(false);
    expect(code(() => acceptInvite(st, USER, V, row.id))).toBe('user.not_pending');
    expect(code(() => acceptInvite(st, AGENT, V, row.id))).toBe('agent.forbidden_setting');
  });
  it('a pending holder of a custom admin role does not count: the only real admin still cannot be removed', () => {
    const st = seed('accountant');
    const adm = createRole(st, USER, V, { name: 'ผู้ดูแลย่อย', permissions: ['users.manage'] });
    inviteUser(st, USER, V, { name: 'ผี', email: 'ghost@maliwan.example', roleId: adm.id });
    expect(code(() => setUserActive(st, USER, V, 'usr-vat-2', false, 1))).toBe('user.last_admin'); // the pending one does not count, so usr-vat-2 is the last real admin
  });
});

describe('M3: corrections judge the effective permission list (a custom role), not the toolbar role', () => {
  it('a list without doc.CN.issue sees the credit note as missing and cannot run the plan', () => {
    const st = seed();
    const ti = st.docs.find((d) => d.type === 'TI' && d.status === 'settled' && !d.locks.some((l) => l.kind === 'filing'))!;
    const body = { header: ti.header, lines: ti.lines.map((l, i) => (i === 0 ? { ...l, unitPrice: '1.00' } : l)) }; // a lower total: the plan issues a credit note
    const noCn = PERMISSIONS_BY_ROLE.accountant.filter((p) => p !== 'doc.CN.issue');
    expect(correctionPlan(st, ti.id, body, 'accountant').missingPermissions).toEqual([]);
    const plan = correctionPlan(st, ti.id, body, noCn);
    expect(plan.missingPermissions).toContain('doc.CN.issue');
    const before = st.docs.length;
    expect(() => executePlan(st, plan.planId, plan.planHash, USER, noCn)).toThrow(/auth\.forbidden/);
    expect(() => executePlan(st, plan.planId, plan.planHash, USER)).toThrow(/auth\.forbidden/); // the stored list applies when none is passed
    expect(st.docs.length).toBe(before);
  });
});

describe('M2: I3 on every paper, and between two edits', () => {
  const paperFor = (st: ReturnType<typeof seed>, id: string) => { const d = st.docs.find((x) => x.id === id)!; return PAPER_BUILDERS[d.type]!({ st, company: st.companies.find((c) => c.id === V)!, s: {}, perms: [] } as never, d, false).seller; };
  const identity = (name: string) => ({ legalNameTh: name, taxId: '0105569012345', branchCode: '00000', address: `ที่อยู่ของ ${name}`, confirm: true });
  it('RC / CN / WT / PR papers (and the TI) keep the seller they were issued under after an identity edit', () => {
    const st = seed();
    const issuedOf = (t: string) => st.docs.find((d) => d.companyId === V && d.type === t && d.number && d.issuedAt);
    // r2-m4: every paper kind is exercised - one the seed lacks is made in-test from an issued TI (never skipped)
    const picks = ['TI', 'RC', 'CN', 'WT', 'PR'].map((t) => {
      if (!issuedOf(t)) st.docs.push({ ...structuredClone(issuedOf('TI')!), id: `st1a-${t}`, type: t } as (typeof st.docs)[number]);
      return issuedOf(t);
    });
    expect(picks.map((d) => d?.type)).toEqual(['TI', 'RC', 'CN', 'WT', 'PR']);
    const was = picks.map((d) => paperFor(st, d!.id));
    updateCompany(st, USER, V, 'identity', identity('บริษัท ใหม่หนึ่ง จำกัด'));
    expect(picks.map((d) => paperFor(st, d!.id))).toEqual(was);
    expect(was.every((s) => s.name === 'บริษัท มะลิวัลย์ ดีไซน์ เวิร์คส์ จำกัด')).toBe(true);
  });
  it('a document issued between two edits prints the MIDDLE identity', () => {
    const st = seed();
    updateCompany(st, USER, V, 'identity', identity('บริษัท กลาง จำกัด'));
    const draft = st.docs.find((d) => d.companyId === V && d.type === 'QT' && d.status === 'draft');
    expect(draft, 'the seed holds a QT draft in co-vat').toBeTruthy();
    issue(st, draft!.id, draft!.version, USER);
    updateCompany(st, USER, V, 'identity', identity('บริษัท สุดท้าย จำกัด'));
    expect(paperFor(st, draft!.id).name).toBe('บริษัท กลาง จำกัด');
  });
});

describe('wire: agent refusal on every roles / users write, before the body is looked at', () => {
  const call = (method: string, path: string, body?: unknown, agent = false) =>
    fetch(`http://localhost/bff/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(agent ? { 'x-teas-actor': 'agent' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  it('PUT and DELETE /settings/roles/:id, /active with a malformed body, and /accept: 403 agent.forbidden_setting', async () => {
    const made = (await (await call('POST', '/settings/roles', { name: 'เป้าหมาย', permissions: ['party.read'] })).json()) as { id: string };
    const before = JSON.stringify(loadState());
    for (const [m, p, b] of [['PUT', `/settings/roles/${made.id}`, { name: 'x', version: 1 }], ['DELETE', `/settings/roles/${made.id}`, undefined],
      ['POST', '/settings/users/usr-vat-3/active', { active: 'nope' }], ['POST', '/settings/users/usr-vat-3/accept', {}]] as const) {
      const r = await call(m, p, b, true);
      expect([m, p, r.status, ((await r.json()) as { code: string }).code]).toEqual([m, p, 403, 'agent.forbidden_setting']);
    }
    expect(JSON.stringify(loadState())).toBe(before);
  });
  it('accept over the wire clears the pending flag', async () => {
    const inv = (await (await call('POST', '/settings/users', { name: 'คนใหม่', email: 'n@maliwan.example', roleId: 'operator' })).json()) as { id: string };
    const r = await call('POST', `/settings/users/${inv.id}/accept`, {});
    expect(r.status).toBe(200);
    expect(((await r.json()) as { invitePending: boolean }).invitePending).toBe(false);
  });
});

describe('r2-m1: u-1 follows the toolbar role on READ only; the stored membership is never rewritten', () => {
  const call = (method: string, path: string, body?: unknown) =>
    fetch(`http://localhost/bff/v1${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const stored = () => loadState().staff.find((m) => m.companyId === V && m.userId === 'u-1')!.roleId;
  it('a settings write under another toolbar role leaves the stored role; the users list and permissions follow the toolbar', async () => {
    setSettings({ role: 'accountant' }); resetState();
    expect(stored()).toBe('accountant');
    setSettings({ role: 'admin' });
    expect((await call('POST', '/settings/roles', { name: 'บทบาททดสอบ', permissions: ['party.read'] })).status).toBe(201);
    expect(stored()).toBe('accountant');
    const users = (await (await call('GET', '/settings/users')).json()) as { items: { id: string; roleId: string }[] };
    expect(users.items.find((u) => u.id === 'usr-vat-1')!.roleId).toBe('admin');
    expect(stored()).toBe('accountant');
  });
});

describe('ST2a: the item form reads the company\'s editable expense categories', () => {
  const call = (method: string, path: string, body?: unknown) =>
    fetch(`http://localhost/bff/v1${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const item = { kind: 'good', code: 'ST2A-01', name: 'ของเบ็ดเตล็ด', unit: 'ชิ้น', unitPrice: '10', taxCode: 'S7', usageSales: false, usagePurchase: true };
  it('a category added in settings is listed AND accepted on an item; before it exists the item is refused; another company does not see it', async () => {
    setSettings({ role: 'accountant' });
    expect((await call('POST', '/records/item', { ...item, expenseCategory: 'misc' })).status).toBe(422);
    expect((await call('POST', '/settings/expense-categories', { code: 'misc', nameTh: 'เบ็ดเตล็ด', accountCode: '5140', recoverableVat: true })).status).toBe(201);
    const list = (await (await call('GET', '/settings/expense-categories')).json()) as { items: { code: string }[] };
    expect(list.items.map((c) => c.code)).toContain('misc');
    const ok = await call('POST', '/records/item', { ...item, expenseCategory: 'misc' });
    expect(ok.status).toBe(201);
    setSettings({ companyKey: 'nonvat' });
    expect((await call('POST', '/records/item', { ...item, code: 'ST2A-02', expenseCategory: 'misc' })).status).toBe(422);
  });
});

describe('ST2c N2: no accessor objects in state - a structuredClone path (correction plan, asset disposal) cannot persist the toolbar role', () => {
  it('toolbar = accountant, u-1 stored admin: ctx() + clone + assign + save keeps admin stored; the users list shows the toolbar role', async () => {
    setSettings({ role: 'admin' }); resetState();
    setSettings({ role: 'accountant' });
    const c = ctx();
    expect(c.st.staff.find((m) => m.companyId === V && m.userId === 'u-1')!.roleId).toBe('admin'); // ctx() leaves the stored rows alone
    const work = structuredClone(c.st);
    Object.assign(c.st, work);
    saveState(c.st);
    expect(loadState().staff.find((m) => m.companyId === V && m.userId === 'u-1')!.roleId).toBe('admin');
    expect(listUsers(loadState(), V, 'accountant').find((u) => u.id === 'usr-vat-1')!.roleId).toBe('accountant');
    expect(listUsers(loadState(), V).find((u) => u.id === 'usr-vat-1')!.roleId).toBe('admin');
  });
});
