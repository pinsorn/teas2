// SP3 4.8 conformance: the frozen platform contract vs the types generated from docs/api/openapi.v1.json (`pnpm gen:api`).
// A mismatch is a `tsc` error in `pnpm typecheck`. One line per route is added by the task that makes the route live, e.g.
//   type _me = Assert<Same<Me, Gen.paths['/me']['get']['responses'][200]['content']['application/json']>>;
// (routes.test.ts fails a documented route that has no line here). Not frozen: this file only reads the frozen ones.
import type { ApiProblem } from '../platform';
import type { Money } from '../scalars';
import type * as Gen from '../generated/openapi';

export type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
export type Assert<T extends true> = T;

// Wire scalars and the error body (no route needed): Money is the 2-dp pattern string, never a number.
export type _money = Assert<Same<Money, Gen.components['schemas']['Money']>>;
export type _apiProblem = Assert<Same<ApiProblem, Gen.components['schemas']['ApiProblem']>>;
