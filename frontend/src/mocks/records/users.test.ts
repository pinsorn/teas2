import { describe, expect, it } from 'vitest';
import { AGENT, USER } from '../fixtures/documents';
import { effectivePermissions, permissionsOf, PERMISSIONS_BY_ROLE } from '../permissions';
import { buildSeedState } from '../store';
import { createRole } from './roles';
import { inviteUser, listUsers, resetLink, setUserActive, updateUser } from './users';

const seed = (role: 'operator' | 'accountant' | 'admin' = 'accountant') => buildSeedState(role);
const code = (f: () => unknown) => { try { f(); } catch (e) { return (e as { message: string }).message.split(':')[0]; } return undefined; };
const fe = (f: () => unknown) => { try { f(); } catch (e) { return (e as { fieldErrors?: Record<string, string[]> }).fieldErrors; } return undefined; };
const V = 'co-vat';
const invite = { name: 'คนใหม่ ทดสอบ', email: 'new@maliwan.example', roleId: 'operator', position: 'พนักงาน' };
const token = (link: string) => link.split('/').pop()!;

describe('users (ST1)', () => {
  it('lists the members of THIS company only', () => {
    const st = seed();
    expect(listUsers(st, V).map((u) => u.id).sort()).toEqual(['usr-vat-1', 'usr-vat-2', 'usr-vat-3']);
    expect(listUsers(st, 'co-nonvat').every((u) => u.id.startsWith('usr-nonvat'))).toBe(true);
  });

  // ruling 6
  it('invite: the link comes back ONCE; the row, the list, the state and the audit keep only a hash', () => {
    const st = seed();
    const { row, link } = inviteUser(st, USER, V, invite);
    expect(link).toMatch(/^https:\/\/.+\/link\/[\w-]{16,}$/);
    expect(row.invitePending).toBe(true);
    expect(JSON.stringify(listUsers(st, V))).not.toContain(token(link));
    expect(JSON.stringify(st.staff)).not.toContain(token(link));
    expect(JSON.stringify(st.audit)).not.toContain(token(link));
    expect(st.staff.find((m) => m.id === row.id)!.linkHash).toBeTruthy();
    expect(st.audit.at(-1)).toMatchObject({ command: 'user.invite', companyId: V, target: row.id });
  });
  it('invite: email unique per company, valid, role must exist in this company', () => {
    const st = seed();
    expect(fe(() => inviteUser(st, USER, V, { ...invite, email: 'somsri@maliwan.example' }))?.email).toHaveLength(1);
    expect(fe(() => inviteUser(st, USER, V, { ...invite, email: 'bad' }))?.email).toHaveLength(1);
    expect(fe(() => inviteUser(st, USER, V, { ...invite, roleId: 'nope' }))?.roleId).toHaveLength(1);
    const other = createRole(st, USER, 'co-nonvat', { name: 'บทบาทอื่น', permissions: ['party.read'] });
    expect(fe(() => inviteUser(st, USER, V, { ...invite, roleId: other.id }))?.roleId).toHaveLength(1); // another company
  });
  it('reset link: never stored in clear; a second call makes a NEW link; refused for a deactivated member', () => {
    const st = seed();
    const a = resetLink(st, USER, V, 'usr-vat-3'), b = resetLink(st, USER, V, 'usr-vat-3');
    expect(a).not.toBe(b);
    expect(JSON.stringify(st)).not.toContain(token(a));
    setUserActive(st, USER, V, 'usr-vat-3', false, 1);
    expect(code(() => resetLink(st, USER, V, 'usr-vat-3'))).toBe('user.inactive');
  });
  it('change role + position + signature; audited with before / after; the picture is redacted from the trail', () => {
    const st = seed();
    const png = `data:image/png;base64,${Buffer.from('sig').toString('base64')}`;
    const r = updateUser(st, USER, V, 'usr-vat-3', { roleId: 'accountant', position: 'บัญชี', signatureDataUrl: png, version: 1 });
    expect(r).toMatchObject({ roleId: 'accountant', position: 'บัญชี', version: 2 });
    const a = st.audit.at(-1)!;
    expect(a).toMatchObject({ command: 'user.update', target: 'usr-vat-3', before: { roleId: 'operator' }, after: { roleId: 'accountant' } });
    expect(JSON.stringify(a)).not.toContain('base64');
    expect(fe(() => updateUser(st, USER, V, 'usr-vat-3', { signatureDataUrl: 'data:image/svg+xml;base64,AAAA', version: 2 }))?.signatureDataUrl).toHaveLength(1); // signature: no svg
    expect(code(() => updateUser(st, USER, V, 'usr-vat-3', { position: 'x', version: 1 }))).toBe('record.version_conflict');
  });
  it('last admin: cannot be deactivated or demoted (user.last_admin); a second admin makes the first removable', () => {
    const st = seed('accountant'); // one admin in the company: usr-vat-2
    expect(code(() => setUserActive(st, USER, V, 'usr-vat-2', false, 1))).toBe('user.last_admin');
    expect(code(() => updateUser(st, USER, V, 'usr-vat-2', { roleId: 'accountant', version: 1 }))).toBe('user.last_admin');
    expect(st.staff.find((m) => m.id === 'usr-vat-2')).toMatchObject({ active: true, roleId: 'admin', version: 1 });
    const n = st.audit.length;
    updateUser(st, USER, V, 'usr-vat-3', { roleId: 'admin', version: 1 });
    expect(setUserActive(st, USER, V, 'usr-vat-2', false, 1).active).toBe(false);
    expect(code(() => setUserActive(st, USER, V, 'usr-vat-3', false, 2))).toBe('user.last_admin'); // now usr-vat-3 is the last one
    expect(st.audit.length).toBe(n + 2); // refusals write no audit row
  });
  it('a custom role that holds users.manage counts as an admin role', () => {
    const st = seed();
    const r = createRole(st, USER, V, { name: 'ผู้ดูแลย่อย', permissions: ['users.manage'] });
    updateUser(st, USER, V, 'usr-vat-3', { roleId: r.id, version: 1 });
    expect(setUserActive(st, USER, V, 'usr-vat-2', false, 1).active).toBe(false); // usr-vat-3 still administers
  });
  it('a user cannot deactivate or demote themselves out of admin, even when others administer (same code)', () => {
    const st = seed('admin'); // u-1 is an admin here and so is usr-vat-2
    expect(code(() => setUserActive(st, USER, V, 'usr-vat-1', false, 1))).toBe('user.last_admin');
    expect(code(() => updateUser(st, USER, V, 'usr-vat-1', { roleId: 'operator', version: 1 }))).toBe('user.last_admin');
    const noAdmin = createRole(st, USER, V, { name: 'ไม่มีสิทธิ์ผู้ดูแล', permissions: ['party.read'] });
    expect(code(() => updateUser(st, USER, V, 'usr-vat-1', { roleId: noAdmin.id, version: 1 }))).toBe('user.last_admin'); // the lock-out through a custom role
    expect(updateUser(st, USER, V, 'usr-vat-1', { position: 'ใหม่', version: 1 }).position).toBe('ใหม่'); // other edits are fine
  });
  it('deactivate then activate keeps the row; the version moves', () => {
    const st = seed();
    expect(setUserActive(st, USER, V, 'usr-vat-3', false, 1)).toMatchObject({ active: false, version: 2 });
    expect(setUserActive(st, USER, V, 'usr-vat-3', true, 2)).toMatchObject({ active: true, version: 3 });
  });

  // ruling 5
  it('an agent is refused on every users write, and nothing changes', () => {
    const st = seed();
    const snap = JSON.stringify([st.staff, st.audit.length]);
    expect(code(() => inviteUser(st, AGENT, V, invite))).toBe('agent.forbidden_setting');
    expect(code(() => updateUser(st, AGENT, V, 'usr-vat-3', { position: 'x', version: 1 }))).toBe('agent.forbidden_setting');
    expect(code(() => setUserActive(st, AGENT, V, 'usr-vat-3', false, 1))).toBe('agent.forbidden_setting');
    expect(code(() => resetLink(st, AGENT, V, 'usr-vat-3'))).toBe('agent.forbidden_setting');
    expect(JSON.stringify([st.staff, st.audit.length])).toBe(snap);
  });

  // ruling 8
  it('another company has its own users: its ids are 404 on every command', () => {
    const st = seed();
    for (const f of [() => updateUser(st, USER, V, 'usr-nonvat-2', { position: 'x', version: 1 }), () => setUserActive(st, USER, V, 'usr-nonvat-2', false, 1), () => resetLink(st, USER, V, 'usr-nonvat-2')]) {
      expect(code(f)).toBe('record.not_found');
    }
  });

  // ruling 7
  it('a custom role really restricts: the mock resolves the role own list, not a system list', () => {
    const st = seed('admin');
    const r = createRole(st, USER, V, { name: 'ดูอย่างเดียว', permissions: ['users.manage', 'party.read', 'item.read'] });
    expect(permissionsOf(st, V, r.id)).toEqual(['users.manage', 'party.read', 'item.read']);
    expect(permissionsOf(st, 'co-nonvat', r.id)).toEqual([]); // not in another company
    expect(permissionsOf(st, V, 'accountant')).toEqual(PERMISSIONS_BY_ROLE.accountant);
    expect(effectivePermissions(st, V, 'admin')).toEqual(PERMISSIONS_BY_ROLE.admin); // a system role: the toolbar rules
    updateUser(st, USER, V, 'usr-vat-1', { roleId: r.id, version: 1 }); // assigned the way the page does it: u-1 holds the custom role and it applies, whatever the toolbar says
    expect(effectivePermissions(st, V, 'admin')).toEqual(['users.manage', 'party.read', 'item.read']);
    expect(effectivePermissions(st, 'co-nonvat', 'admin')).toEqual(PERMISSIONS_BY_ROLE.admin); // only in the company that gave it
  });

  // ST1b m4
  it('m4: a deactivated u-1 holds NOTHING (never the wider toolbar role); an active u-1 is unchanged', () => {
    const st = seed('accountant'); // u-1 is an accountant, so deactivating her is allowed
    expect(effectivePermissions(st, V, 'accountant')).toEqual(PERMISSIONS_BY_ROLE.accountant);
    setUserActive(st, USER, V, 'usr-vat-1', false, 1);
    expect(effectivePermissions(st, V, 'admin')).toEqual([]);
    expect(effectivePermissions(st, 'co-nonvat', 'admin')).toEqual(PERMISSIONS_BY_ROLE.admin); // the other company's membership is its own
  });
});
