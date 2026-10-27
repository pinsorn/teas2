// SP3 4.8 conformance: the frozen platform contract vs the types generated from docs/api/openapi.v1.json (`pnpm gen:api`).
// A mismatch is a `tsc` error in `pnpm typecheck`. One line per route is added by the task that makes the route live, e.g.
//   type _me = Assert<Same<Me, Gen.paths['/me']['get']['responses'][200]['content']['application/json']>>;
// (routes.test.ts fails a documented route that has no line here). Not frozen: this file only reads the frozen ones.
import type { ApiProblem, CompanyContactBody, CompanyFiscalBody, CompanyIdentityBody, CompanyImagesBody, CompanyNotesBody, CompanyPayrollBody, CompanySettings, InviteBody, LinkInfo,
  LoginResult, Me, ProfileView, RoleBody, RoleRow, SessionRow, SessionState, SetPasswordBody, UpdateMemberBody, UpdateRoleBody, UserRow } from '../platform';
import type { DocType } from '@/domain/types';
import type { Money } from '../scalars';
import type * as Gen from '../generated/openapi';

export type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
export type Assert<T extends true> = T;

// Wire scalars and the error body (no route needed): Money is the 2-dp pattern string, never a number.
export type _money = Assert<Same<Money, Gen.components['schemas']['Money']>>;
export type _apiProblem = Assert<Same<ApiProblem, Gen.components['schemas']['ApiProblem']>>;

// ---- P7: routes 1-14 (auth). Response = the 200 JSON body of the operation, Req = its JSON request body. Shapes that have no named frozen type are written
// out from the ROUTES row of platform.ts (request / response column).
type Res<O> = O extends { responses: { 200: { content: { 'application/json': infer R } } } } ? R : never;
type Req<O> = O extends { requestBody: { content: { 'application/json': infer B } } } ? B : never;
type OkBody = { status: 'ok' };

export type _login = Assert<Same<LoginResult, Res<Gen.paths['/auth/login']['post']>>>;
export type _loginReq = Assert<Same<{ email: string; password: string }, Req<Gen.paths['/auth/login']['post']>>>;
export type _totp = Assert<Same<OkBody, Res<Gen.paths['/auth/totp']['post']>>>;
export type _totpReq = Assert<Same<{ challenge: string; code?: string; recoveryCode?: string }, Req<Gen.paths['/auth/totp']['post']>>>;
export type _session = Assert<Same<{ state: SessionState; email?: string; expiresInSec?: number }, Res<Gen.paths['/auth/session']['get']>>>;
export type _extend = Assert<Same<{ state: 'active' }, Res<Gen.paths['/auth/session/extend']['post']>>>;
export type _logout = Assert<Same<{ state: 'out' }, Res<Gen.paths['/auth/logout']['post']>>>;
export type _relogin = Assert<Same<{ status: 'ok' | 'totp_required' }, Res<Gen.paths['/auth/relogin']['post']>>>;
export type _reloginReq = Assert<Same<{ password: string; code?: string; recoveryCode?: string }, Req<Gen.paths['/auth/relogin']['post']>>>;
export type _profile = Assert<Same<ProfileView, Res<Gen.paths['/auth/profile']['get']>>>;
export type _password = Assert<Same<OkBody, Res<Gen.paths['/auth/password']['post']>>>;
export type _passwordReq = Assert<Same<{ current: string; next: string; confirm: string }, Req<Gen.paths['/auth/password']['post']>>>;
export type _enrol = Assert<Same<{ secret: string; uri: string }, Res<Gen.paths['/auth/totp/enrol']['post']>>>;
export type _enrolVerify = Assert<Same<{ recoveryCodes: string[] }, Res<Gen.paths['/auth/totp/enrol/verify']['post']>>>;
export type _enrolVerifyReq = Assert<Same<{ code: string }, Req<Gen.paths['/auth/totp/enrol/verify']['post']>>>;
export type _sessions = Assert<Same<{ items: SessionRow[] }, Res<Gen.paths['/auth/sessions']['get']>>>;
export type _revoke = Assert<Same<{ signedOut: boolean }, Res<Gen.paths['/auth/sessions/{id}/revoke']['post']>>>;
export type _linkInfo = Assert<Same<LinkInfo, Res<Gen.paths['/auth/links/{token}']['get']>>>;
export type _linkAccept = Assert<Same<OkBody, Res<Gen.paths['/auth/links/{token}']['post']>>>;
export type _linkAcceptReq = Assert<Same<SetPasswordBody, Req<Gen.paths['/auth/links/{token}']['post']>>>;

// ---- P8: routes 15-29 (me, company settings, users, roles). A 201 answer is read with Res201; the DELETE carries its version in the query string. ----
type Res201<O> = O extends { responses: { 201: { content: { 'application/json': infer R } } } } ? R : never;
type Query<O> = O extends { parameters: { query: infer Q } } ? Q : never;

export type _me = Assert<Same<Me, Res<Gen.paths['/me']['get']>>>;
export type _switch = Assert<Same<Me, Res<Gen.paths['/me/active-company']['post']>>>;
export type _switchReq = Assert<Same<{ companyId: string }, Req<Gen.paths['/me/active-company']['post']>>>;
export type _company = Assert<Same<CompanySettings, Res<Gen.paths['/settings/companies/{id}']['get']>>>;
export type _companyPut = Assert<Same<CompanySettings, Res<Gen.paths['/settings/companies/{id}/{section}']['put']>>>;
// one operation for the six sections: its body is the union of the six Company<Section>Body shapes
export type _companyPutReq = Assert<Same<CompanyIdentityBody | CompanyContactBody | CompanyPayrollBody | CompanyFiscalBody | CompanyImagesBody | CompanyNotesBody,
  Req<Gen.paths['/settings/companies/{id}/{section}']['put']>>>;
export type _defaultNotes = Assert<Same<Partial<Record<DocType, string>>, Res<Gen.paths['/settings/default-notes']['get']>>>;
export type _users = Assert<Same<{ items: UserRow[] }, Res<Gen.paths['/settings/users']['get']>>>;
export type _invite = Assert<Same<UserRow & { link: string }, Res201<Gen.paths['/settings/users']['post']>>>;
export type _inviteReq = Assert<Same<InviteBody, Req<Gen.paths['/settings/users']['post']>>>;
export type _userUpdate = Assert<Same<UserRow, Res<Gen.paths['/settings/users/{id}']['put']>>>;
export type _userUpdateReq = Assert<Same<UpdateMemberBody, Req<Gen.paths['/settings/users/{id}']['put']>>>;
export type _active = Assert<Same<UserRow, Res<Gen.paths['/settings/users/{id}/active']['post']>>>;
export type _activeReq = Assert<Same<{ active: boolean; version: number }, Req<Gen.paths['/settings/users/{id}/active']['post']>>>;
export type _resetLink = Assert<Same<{ link: string }, Res<Gen.paths['/settings/users/{id}/reset-link']['post']>>>;
export type _totpReset = Assert<Same<UserRow, Res<Gen.paths['/settings/users/{id}/totp-reset']['post']>>>;
export type _totpResetReq = Assert<Same<{ version: number }, Req<Gen.paths['/settings/users/{id}/totp-reset']['post']>>>;
export type _roles = Assert<Same<{ items: RoleRow[] }, Res<Gen.paths['/settings/roles']['get']>>>;
export type _roleCreate = Assert<Same<RoleRow, Res201<Gen.paths['/settings/roles']['post']>>>;
export type _roleCreateReq = Assert<Same<RoleBody, Req<Gen.paths['/settings/roles']['post']>>>;
export type _roleUpdate = Assert<Same<RoleRow, Res<Gen.paths['/settings/roles/{id}']['put']>>>;
export type _roleUpdateReq = Assert<Same<UpdateRoleBody, Req<Gen.paths['/settings/roles/{id}']['put']>>>;
export type _roleDelete = Assert<Same<{ ok: true }, Res<Gen.paths['/settings/roles/{id}']['delete']>>>;
export type _roleDeleteQuery = Assert<Same<{ version: number }, Query<Gen.paths['/settings/roles/{id}']['delete']>>>;
