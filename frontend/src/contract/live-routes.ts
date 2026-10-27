import type { RouteSpec } from './route-spec';

// Routes served by the real backend instead of the mock (SP3 P10 switches `platform` on, route by route; spec 4.8). Empty until then.
export const LIVE_ROUTES: readonly { method: RouteSpec['method']; path: string }[] = [];
