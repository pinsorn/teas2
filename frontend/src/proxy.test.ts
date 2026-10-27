// @vitest-environment node
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LIVE_ROUTES, isLiveRoute } from './contract/live-routes';
import { ERROR_CODES, ROUTES } from './contract/platform';
import { clientIp, forwardHeaders, proxy } from './proxy';

// SP3 4.8 / S7: the BFF. Pure header and decision logic; the rewrite itself is Next's.
const SECRET = 'bff-secret-0123456789abcdef0123456789';
const APP = 'https://app.example.test';
const req = (method: string, path: string, init: { headers?: Record<string, string>; origin?: string | null; json?: boolean } = {}) => {
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  if (init.origin !== null) headers.origin = init.origin ?? APP;
  if (init.json !== false && method !== 'GET') headers['content-type'] = 'application/json';
  return new NextRequest(`${APP}/bff/v1${path}`, { method, headers, body: method === 'GET' ? undefined : '{}' });
};
const rewritten = (res: Response | undefined) => res?.headers.get('x-middleware-rewrite') ?? undefined;
const sentHeader = (res: Response, name: string) => res.headers.get(`x-middleware-request-${name}`);

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_API_MODE', 'hybrid');
  vi.stubEnv('TEAS_API_INTERNAL_URL', 'http://api:8080/');
  vi.stubEnv('TEAS_BFF_SECRET', SECRET);
  vi.stubEnv('TEAS_TRUSTED_PROXY_HOPS', '');
});
afterEach(() => vi.unstubAllEnvs());

describe('live routes', () => {
  it('are routes 1-33: every contract route that is not a machine (key) route', () => {
    expect(LIVE_ROUTES).toHaveLength(33);
    expect(LIVE_ROUTES).toEqual(ROUTES.filter((r) => r.auth !== 'key').map(({ method, path }) => ({ method, path })));
  });
  it('match by method and path template; a parameter is one segment', () => {
    expect(isLiveRoute('POST', '/auth/links/abc')).toBe(true);
    expect(isLiveRoute('GET', '/auth/links/abc')).toBe(true);
    expect(isLiveRoute('DELETE', '/settings/roles/r1')).toBe(true);
    expect(isLiveRoute('GET', '/auth/links/abc/extra')).toBe(false);
    expect(isLiveRoute('PUT', '/auth/login')).toBe(false); // wrong method
    expect(isLiveRoute('GET', '/docs/QT')).toBe(false); // still on the mock
    expect(isLiveRoute('GET', '/api/v1/whoami')).toBe(false); // machine-only
  });
});

describe('forwardHeaders', () => {
  it('strips x-teas-actor and a forged X-Teas-Bff, adds the secret, keeps cookie and the rest', () => {
    const h = forwardHeaders(req('GET', '/me', { headers: { 'x-teas-actor': 'agent', 'X-Teas-Bff': 'forged', cookie: '__Host-teas_session=abc', 'idempotency-key': 'k1' } }), SECRET);
    expect(h.get('x-teas-actor')).toBeNull();
    expect(h.get('x-teas-bff')).toBe(SECRET);
    expect(h.get('cookie')).toBe('__Host-teas_session=abc');
    expect(h.get('idempotency-key')).toBe('k1');
  });
  it('forwards the client IP in X-Teas-Client-Ip and never the one a client sent under that name', () => {
    const forged = req('GET', '/me', { headers: { 'x-teas-client-ip': '6.6.6.6' } });
    expect(forwardHeaders(forged, SECRET).get('x-teas-client-ip')).toBeNull(); // no proxy header: the API falls back to the peer
    const behind = req('GET', '/me', { headers: { 'x-teas-client-ip': '6.6.6.6', 'x-forwarded-for': '1.1.1.1, 203.0.113.9' } });
    expect(forwardHeaders(behind, SECRET).get('x-teas-client-ip')).toBe('203.0.113.9'); // the last hop = what the one trusted proxy saw
  });
  it('clientIp: counts hops from the right, never goes past the left end, ignores an empty header', () => {
    expect(clientIp('9.9.9.9, 1.1.1.1, 2.2.2.2', 1)).toBe('2.2.2.2');
    expect(clientIp('9.9.9.9, 1.1.1.1, 2.2.2.2', 2)).toBe('1.1.1.1');
    expect(clientIp('9.9.9.9', 3)).toBe('9.9.9.9');
    expect(clientIp(null, 1)).toBeUndefined();
    expect(clientIp(' ', 1)).toBeUndefined();
  });
  it('TEAS_TRUSTED_PROXY_HOPS moves the trusted hop', () => {
    vi.stubEnv('TEAS_TRUSTED_PROXY_HOPS', '2');
    const r = req('GET', '/me', { headers: { 'x-forwarded-for': '1.1.1.1, 172.70.0.1, 10.0.0.2' } });
    expect(forwardHeaders(r, SECRET).get('x-teas-client-ip')).toBe('172.70.0.1');
  });
});

describe('proxy', () => {
  it('every code it answers with is registered in the frozen contract', () => {
    for (const c of ['http.403', 'http.500', 'record.not_found']) expect(ERROR_CODES).toHaveProperty([c]);
  });
  it('rewrites a live route to the internal surface with the secret, the query kept', () => {
    const res = proxy(req('GET', '/connect/keys?x=1', { headers: { 'x-teas-actor': 'agent', 'x-teas-bff': 'forged' } }))!;
    expect(rewritten(res)).toBe('http://api:8080/internal/v1/connect/keys?x=1');
    expect(sentHeader(res, 'x-teas-bff')).toBe(SECRET);
    expect(res.headers.get('x-middleware-override-headers')).not.toContain('x-teas-actor'); // the list is what is kept
    expect(sentHeader(res, 'x-teas-actor')).toBeNull();
  });
  it('mock mode (the default build) leaves everything to the browser worker', () => {
    vi.stubEnv('NEXT_PUBLIC_API_MODE', '');
    expect(rewritten(proxy(req('GET', '/me')))).toBeUndefined();
    vi.stubEnv('NEXT_PUBLIC_API_MODE', 'mock');
    expect(rewritten(proxy(req('GET', '/me')))).toBeUndefined();
  });
  it('hybrid: a route that is not live stays on the mock; live mode sends everything to the API', () => {
    expect(rewritten(proxy(req('GET', '/docs/QT')))).toBeUndefined();
    vi.stubEnv('NEXT_PUBLIC_API_MODE', 'live');
    expect(rewritten(proxy(req('GET', '/docs/QT')))).toBe('http://api:8080/internal/v1/docs/QT');
  });
  it('an unconfigured BFF answers 500 http.500 (a registered code) and forwards nothing', async () => {
    vi.stubEnv('TEAS_BFF_SECRET', '');
    const res = proxy(req('GET', '/me'))!;
    expect(res.status).toBe(500);
    expect(rewritten(res)).toBeUndefined();
    expect((await res.json()).code).toBe('http.500');
  });

  it('a path that is not exactly under /bff/v1 is a 404 and nothing is forwarded (dot segments, a longer first segment)', async () => {
    for (const raw of ['/bff/v1/a/../../internal/v1/me', '/bff/v1/../xy/me', '/bff/v1x/me', '/bff/v1/%2e%2e/%2e%2e/internal/v1/me']) {
      const res = proxy(new NextRequest(`${APP}${raw}`, { headers: { origin: APP } }));
      expect(res.status, raw).toBe(404);
      expect(rewritten(res), raw).toBeUndefined();
    }
    expect((await proxy(new NextRequest(`${APP}/bff/v1/a/../../internal/v1/me`)).json()).code).toBe('record.not_found');
    expect(proxy(new NextRequest(`${APP}/bff/v1`)).status).not.toBe(404); // the bare prefix is still ours (not a live route: left to Next)
  });

  describe('S7 - a mutating request needs a JSON content type and this app as Origin', () => {
    it('refuses a cross-origin POST: 403 http.403, nothing forwarded', async () => {
      const res = proxy(req('POST', '/me/active-company', { origin: 'https://evil.example' }))!;
      expect(res.status).toBe(403);
      expect(rewritten(res)).toBeUndefined();
      expect((await res.json()).code).toBe('http.403');
    });
    it.each(['POST', 'PUT', 'DELETE'] as const)('%s: no Origin, a foreign Origin, or a form content type is refused', (m) => {
      const path = m === 'POST' ? '/settings/roles' : '/settings/roles/r1'; // a live route for that method
      expect(proxy(req(m, path, { origin: null }))!.status).toBe(403);
      expect(proxy(req(m, path, { origin: 'https://evil.example' }))!.status).toBe(403);
      expect(proxy(req(m, path, { origin: 'http://app.example.test' }))!.status).toBe(403); // same host, other scheme
      expect(proxy(req(m, path, { json: false, headers: { 'content-type': 'application/x-www-form-urlencoded' } }))!.status).toBe(403);
      expect(proxy(req(m, path, { json: false, headers: { 'content-type': 'text/plain' } }))!.status).toBe(403);
      expect(rewritten(proxy(req(m, path)))).toBe(`http://api:8080/internal/v1${path}`);
    });
    it('names POST /auth/links/{token} explicitly: route 14 is auth: public but is still a state change, so it gets the same check', async () => {
      const route14 = ROUTES.find((r) => r.method === 'POST' && r.path === '/auth/links/{token}')!;
      expect(route14.auth).toBe('public');
      const url = route14.path.replace('{token}', 'tok-123');
      expect(proxy(req('POST', url, { origin: 'https://evil.example' }))!.status).toBe(403);
      expect(proxy(req('POST', url, { origin: null }))!.status).toBe(403);
      expect(proxy(req('POST', url, { json: false }))!.status).toBe(403);
      const ok = proxy(req('POST', url))!;
      expect(rewritten(ok)).toBe('http://api:8080/internal/v1/auth/links/tok-123');
    });
    it('the Origin is compared with the public host behind a proxy (x-forwarded-host / -proto)', () => {
      const behind = new NextRequest('http://0.0.0.0:3000/bff/v1/auth/logout', {
        method: 'POST', body: '{}',
        headers: { 'content-type': 'application/json; charset=utf-8', origin: 'https://teas.example.test', 'x-forwarded-host': 'teas.example.test', 'x-forwarded-proto': 'https' },
      });
      expect(rewritten(proxy(behind))).toBe('http://api:8080/internal/v1/auth/logout');
    });
    it('a read needs neither Origin nor a content type', () => {
      expect(rewritten(proxy(req('GET', '/me', { origin: null })))).toBe('http://api:8080/internal/v1/me');
    });
  });
});
