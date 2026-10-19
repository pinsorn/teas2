import { describe, expect, it } from 'vitest';
import { PERMISSIONS } from '@/domain/permissions';
import { AGENT, USER } from '../fixtures/documents';
import { PERMISSIONS_BY_ROLE } from '../permissions';
import { buildSeedState } from '../store';
import { createRole, deleteRole, listRoles, updateRole } from './roles';
import { updateUser } from './users';

const seed = () => buildSeedState('accountant');
const code = (f: () => unknown) => { try { f(); } catch (e) { return (e as { message: string }).message.split(':')[0]; } return undefined; };
const fe = (f: () => unknown) => { try { f(); } catch (e) { return (e as { fieldErrors?: Record<string, string[]> }).fieldErrors; } return undefined; };
const V = 'co-vat';

describe('roles (ST1)', () => {
  it('the three system roles are listed, read-only, with the lists the mock grants; every code is in the catalogue', () => {
    const st = seed();
    const rows = listRoles(st, V);
    expect(rows.filter((r) => r.system).map((r) => r.id)).toEqual(['operator', 'accountant', 'admin']);
    for (const r of rows.filter((x) => x.system)) {
      expect(r.permissions).toEqual(PERMISSIONS_BY_ROLE[r.id as 'admin']);
      for (const c of r.permissions) expect(PERMISSIONS[c], c).toBeDefined();
    }
    expect(code(() => updateRole(st, USER, V, 'admin', { name: 'x', version: 1 }))).toBe('role.system_readonly');
    expect(code(() => deleteRole(st, USER, V, 'admin'))).toBe('role.system_readonly');
  });
  it('copy a system role as a new custom role, then edit it', () => {
    const st = seed();
    const copy = createRole(st, USER, V, { name: 'สำเนาของนักบัญชี', permissions: PERMISSIONS_BY_ROLE.accountant });
    expect(copy).toMatchObject({ system: false, version: 1, inUse: false });
    expect(copy.permissions).toEqual(PERMISSIONS_BY_ROLE.accountant);
    const edited = updateRole(st, USER, V, copy.id, { permissions: ['party.read'], version: 1 });
    expect(edited).toMatchObject({ permissions: ['party.read'], version: 2 });
    expect(st.audit.at(-1)).toMatchObject({ command: 'role.update', target: copy.id, companyId: V, before: { permissions: PERMISSIONS_BY_ROLE.accountant }, after: { permissions: ['party.read'] } });
    expect(code(() => updateRole(st, USER, V, copy.id, { name: 'y', version: 1 }))).toBe('record.version_conflict');
  });
  it('validation: a name (unique in the company), and only catalogue codes (deduplicated)', () => {
    const st = seed();
    expect(fe(() => createRole(st, USER, V, { name: ' ', permissions: [] }))?.name).toHaveLength(1);
    expect(fe(() => createRole(st, USER, V, { name: 'ผู้ดูแลระบบ', permissions: [] }))?.name).toHaveLength(1); // a system role's name
    expect(fe(() => createRole(st, USER, V, { name: 'ใหม่', permissions: ['not.a.code'] }))?.permissions).toHaveLength(1);
    const r = createRole(st, USER, V, { name: 'ใหม่', permissions: ['party.read', 'party.read'] });
    expect(r.permissions).toEqual(['party.read']);
    expect(fe(() => createRole(st, USER, V, { name: 'ใหม่', permissions: [] }))?.name).toHaveLength(1);
    expect(createRole(st, USER, 'co-nonvat', { name: 'ใหม่', permissions: [] }).id).not.toBe(r.id); // the name is free in the other company
  });
  it('a role in use cannot be deleted (role.in_use); an unused one can', () => {
    const st = seed();
    const r = createRole(st, USER, V, { name: 'ชั่วคราว', permissions: ['party.read'] });
    updateUser(st, USER, V, 'usr-vat-3', { roleId: r.id, version: 1 });
    expect(listRoles(st, V).find((x) => x.id === r.id)!.inUse).toBe(true);
    expect(code(() => deleteRole(st, USER, V, r.id))).toBe('role.in_use');
    updateUser(st, USER, V, 'usr-vat-3', { roleId: 'operator', version: 2 });
    deleteRole(st, USER, V, r.id);
    expect(listRoles(st, V).some((x) => x.id === r.id)).toBe(false);
    expect(st.audit.at(-1)).toMatchObject({ command: 'role.delete', target: r.id });
  });
  it('separation of duties: a role holding create AND approve of a type whose approval is on is flagged (warning only, still saved)', () => {
    const st = seed();
    const rows = listRoles(st, V);
    expect(rows.find((r) => r.id === 'accountant')!.sodTypes).toEqual(['EX', 'PV']); // approval is on for EX and PV in the VAT company; the accountant creates and approves both
    expect(rows.find((r) => r.id === 'operator')!.sodTypes).toEqual([]);
    const r = createRole(st, USER, V, { name: 'ทำเองอนุมัติเอง', permissions: ['doc.EX.create', 'doc.EX.approve', 'doc.QT.create', 'doc.QT.approve'] });
    expect(r.sodTypes).toEqual(['EX']); // QT has no approval policy
    expect(listRoles(st, 'co-nonvat').find((x) => x.id === 'accountant')!.sodTypes).toEqual([]); // the non-VAT company has the rules off
  });
  it('an agent is refused on every role write, and nothing changes', () => {
    const st = seed();
    const r = createRole(st, USER, V, { name: 'เป้าหมาย', permissions: ['party.read'] });
    const snap = JSON.stringify([st.roles, st.audit.length]);
    expect(code(() => createRole(st, AGENT, V, { name: 'x', permissions: [] }))).toBe('agent.forbidden_setting');
    expect(code(() => updateRole(st, AGENT, V, r.id, { name: 'y', version: 1 }))).toBe('agent.forbidden_setting');
    expect(code(() => deleteRole(st, AGENT, V, r.id))).toBe('agent.forbidden_setting');
    expect(JSON.stringify([st.roles, st.audit.length])).toBe(snap);
  });
  it("another company's custom role is 404", () => {
    const st = seed();
    const r = createRole(st, USER, 'co-nonvat', { name: 'ของอีกบริษัท', permissions: ['party.read'] });
    expect(code(() => updateRole(st, USER, V, r.id, { name: 'y', version: 1 }))).toBe('record.not_found');
    expect(code(() => deleteRole(st, USER, V, r.id))).toBe('record.not_found');
    expect(listRoles(st, V).some((x) => x.id === r.id)).toBe(false);
  });
});
