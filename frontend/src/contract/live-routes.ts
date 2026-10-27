import { ROUTES } from './platform';
import type { RouteSpec } from './route-spec';

// Routes served by the real backend instead of the mock (SP3 P10, spec 4.8): the platform routes 1-33 = every frozen route that is not a machine route
// (auth 'key': /api/v1/whoami is called by an agent with a key, never through the BFF). In `hybrid` mode the mock worker passes these through and proxy.ts
// forwards them; a route that is not listed stays on the mock until its own task lists it.
export const LIVE_ROUTES: readonly { method: RouteSpec['method']; path: string }[] =
  ROUTES.filter((r) => r.auth !== 'key').map(({ method, path }) => ({ method, path }));

const matchers = LIVE_ROUTES.map((r) => ({ method: r.method, re: new RegExp(`^${r.path.replace(/\{[^}]+\}/g, '[^/]+')}/?$`) }));

/** Is `METHOD path` (the path after `/bff/v1`, no query) a live route? A `{param}` matches exactly one segment. */
export const isLiveRoute = (method: string, path: string): boolean => matchers.some((m) => m.method === method.toUpperCase() && m.re.test(path));
