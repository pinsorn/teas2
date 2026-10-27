import { setupServer } from 'msw/node';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LIVE_ROUTES } from '@/contract/live-routes';
import { withLiveRoutes, handlers as plain } from './handlers';
import { setSettings } from './settings';
import { resetState } from './store';

// SP3 4.8: in `hybrid` the mock worker lets the live routes through (to proxy.ts -> the API) and keeps answering the rest; `mock` is unchanged.
// An unhandled request here goes to a closed port, so "passed through" shows as a network error and "answered by the mock" as a response.
const call = (path: string, method = 'GET') => fetch(`http://127.0.0.1:59999/bff/v1${path}`, { method, headers: { 'content-type': 'application/json' }, body: method === 'GET' ? undefined : '{}' }).then((r) => r.status, () => 'network' as const);

describe('withLiveRoutes', () => {
  it('mock (the default) returns the handlers untouched', () => {
    expect(withLiveRoutes(plain, undefined)).toBe(plain);
    expect(withLiveRoutes(plain, 'mock')).toBe(plain);
    expect(withLiveRoutes(plain, 'live')).toBe(plain); // live builds do not start the worker at all
  });
  it('hybrid adds one pass-through per live route, in front of the mock handlers', () => {
    expect(withLiveRoutes(plain, 'hybrid')).toHaveLength(plain.length + LIVE_ROUTES.length);
  });

  describe('served', () => {
    const server = setupServer(...withLiveRoutes(plain, 'hybrid'));
    beforeAll(() => server.listen({ onUnhandledFrame: 'bypass' }));
    afterAll(() => server.close());
    beforeEach(() => { localStorage.clear(); resetState(); setSettings({ companyKey: 'vat', role: 'accountant', screenState: 'normal' }); });
    it('a live route reaches the network (path parameters included, any method)', async () => {
      expect(await call('/connect/keys')).toBe('network');
      expect(await call('/auth/links/tok-1', 'POST')).toBe('network');
      expect(await call('/settings/roles/r1', 'DELETE')).toBe('network');
    });
    it('a route that is not live, and a mock-only one, stay on the mock', async () => {
      expect(await call('/connect/apps')).toBe(200);
      expect(await call('/auth/demo')).toBe(200); // F11: mock only, never a live route
    });
  });
});
