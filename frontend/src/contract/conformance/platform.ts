// SP3 4.8 conformance: the frozen platform contract vs the types generated from docs/api/openapi.v1.json (`pnpm gen:api`).
// A mismatch is a `tsc` error in `pnpm typecheck`. One line per route is added by the task that makes the route live, e.g.
//   type _me = Assert<Same<Me, Gen.paths['/me']['get']['responses'][200]['content']['application/json']>>;
// (routes.test.ts fails a documented route that has no line here). Not frozen: this file only reads the frozen ones.
import type { ApiProblem, LinkInfo, LoginResult, ProfileView, SessionRow, SessionState, SetPasswordBody } from '../platform';
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
