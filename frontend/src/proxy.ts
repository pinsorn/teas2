import { NextResponse, type NextRequest } from 'next/server';
import { isLiveRoute } from './contract/live-routes';

// SP3 4.8: the BFF. `/bff/v1/*` -> `${TEAS_API_INTERNAL_URL}/internal/v1/*` for the routes the real API serves (LIVE_ROUTES), with the shared secret
// added, whatever identity header the browser sent removed, and the browser's address in X-Teas-Client-Ip. The API trusts that header only
// after the secret check (BffSecretMiddleware), so a request that did not come through here cannot name its own address.
// NEXT_PUBLIC_API_MODE (fixed at build time): `mock` (default) = the browser's mock worker answers everything and nothing is forwarded;
// `hybrid` = live routes go to the API, the rest stay on the worker; `live` = everything goes to the API.
const PREFIX = '/bff/v1';
const SECRET_HEADER = 'x-teas-bff';
const ACTOR_HEADER = 'x-teas-actor'; // mock only: must never reach the API
const CLIENT_IP_HEADER = 'x-teas-client-ip';
const MUTATING = (method: string) => !['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase());

// Only codes already in the frozen ERROR_CODES: http.403 (CSRF), http.500 (the BFF is not configured), record.not_found (a path that is not under the prefix).
const problem = (status: 403 | 404 | 500, code: 'http.403' | 'http.500' | 'record.not_found', title: string) =>
  NextResponse.json({ status, code, title }, { status, headers: { 'cache-control': 'no-store' } });

/** The client address from X-Forwarded-For: the entry the `hops`-th trusted proxy from the right appended (default 1 = the proxy directly in front of this server). */
export function clientIp(xff: string | null, hops: number): string | undefined {
  const parts = (xff ?? '').split(',').map((p) => p.trim()).filter(Boolean);
  return parts.length ? parts[Math.max(0, parts.length - hops)] : undefined;
}

/** What goes to the API: the browser's headers minus the identity ones, plus the secret and the client IP. */
export function forwardHeaders(request: NextRequest, secret: string): Headers {
  const h = new Headers(request.headers);
  h.delete(ACTOR_HEADER);
  h.delete(CLIENT_IP_HEADER);
  h.set(SECRET_HEADER, secret); // replaces a forged one
  const hops = Number.parseInt(process.env.TEAS_TRUSTED_PROXY_HOPS ?? '', 10);
  const ip = clientIp(request.headers.get('x-forwarded-for'), hops > 0 ? hops : 1);
  if (ip) h.set(CLIENT_IP_HEADER, ip);
  return h;
}

/** S7: the origin this server is reached at (behind Traefik the Host is rewritten, the forwarded headers carry the public one). */
function appOrigin(request: NextRequest): string {
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? request.nextUrl.host;
  const proto = request.headers.get('x-forwarded-proto')?.split(',')[0].trim() ?? request.nextUrl.protocol.replace(':', '');
  return `${proto}://${host}`;
}

export function proxy(request: NextRequest): NextResponse {
  const mode = process.env.NEXT_PUBLIC_API_MODE ?? 'mock';
  const full = request.nextUrl.pathname;
  // the URL is already normalised (dot segments resolved): anything that left the prefix (`/bff/v1/a/../../internal/v1/me`, `/bff/v1x`) is not ours to forward
  if (full !== PREFIX && !full.startsWith(PREFIX + '/')) return problem(404, 'record.not_found', 'Not found');
  const path = full.slice(PREFIX.length) || '/';
  if (mode !== 'live' && (mode !== 'hybrid' || !isLiveRoute(request.method, path))) return NextResponse.next();

  // CSRF: every state change (route 14 `POST /auth/links/{token}` included: `auth: public` is about who may call it, not about who may forge it)
  if (MUTATING(request.method)) {
    const json = (request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json');
    if (!json || request.headers.get('origin') !== appOrigin(request)) return problem(403, 'http.403', 'Forbidden');
  }
  const base = process.env.TEAS_API_INTERNAL_URL?.replace(/\/+$/, '');
  const secret = process.env.TEAS_BFF_SECRET;
  if (!base || !secret) return problem(500, 'http.500', 'The server is not configured');
  return NextResponse.rewrite(new URL(`${base}/internal/v1${path}${request.nextUrl.search}`), { request: { headers: forwardHeaders(request, secret) } });
}

export const config = { matcher: '/bff/v1/:path*' };
