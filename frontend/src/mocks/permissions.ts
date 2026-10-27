import type { MockState } from './store';
import { SYSTEM_ROLES as CONTRACT_ROLES } from '@/contract/platform';
import type { Role } from '@/domain/types';
/** SP3 P0: the lists are the frozen contract's (contract/platform.ts SYSTEM_ROLES); the mock keeps mutable copies. */
export const PERMISSIONS_BY_ROLE: Record<Role, string[]> = { operator: [...CONTRACT_ROLES.operator], accountant: [...CONTRACT_ROLES.accountant], admin: [...CONTRACT_ROLES.admin] };


export const SYSTEM_ROLES: Role[] = ['operator', 'accountant', 'admin'];
export const isSystemRole = (id: string): id is Role => (SYSTEM_ROLES as string[]).includes(id);
/** ST1: what a membership's role grants. A system role is the list above; a custom role is its own list (of ITS company: another company's role id grants nothing); anything unknown grants nothing. */
export function permissionsOf(st: Pick<MockState, 'roles'>, companyId: string, roleId: string): string[] {
  if (isSystemRole(roleId)) return PERMISSIONS_BY_ROLE[roleId];
  return st.roles.find((r) => r.id === roleId && r.companyId === companyId)?.permissions ?? [];
}
/** The signed-in user's permissions: the toolbar role (a simulation of a system role), unless an administrator gave u-1 a CUSTOM role in this company - then that role's list really applies (the toolbar still offers only the three system roles). */
export function effectivePermissions(st: Pick<MockState, 'roles' | 'staff'>, companyId: string, toolbarRole: Role): string[] {
  const me = st.staff.find((m) => m.companyId === companyId && m.userId === 'u-1');
  if (me && !me.active) return []; // ST1b m4: a deactivated user holds nothing (never the wider toolbar role)
  return me && !isSystemRole(me.roleId) ? permissionsOf(st, companyId, me.roleId) : PERMISSIONS_BY_ROLE[toolbarRole];
}
