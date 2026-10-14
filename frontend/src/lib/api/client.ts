import type { ApiProblem } from '@/domain/types';
import en from '@/messages/en.json';
import th from '@/messages/th.json';

export class ApiError extends Error {
  constructor(public problem: ApiProblem) { super(problem.title); }
  get code() { return this.problem.code; }
}

// Fallback titles live in the messages (problem.*); the cookie picks the language, Thai by default.
const messages = () => (typeof document !== 'undefined' && /(?:^|;\s*)locale=en/.test(document.cookie) ? en : th).problem as Record<string, string>;

export function normalizeProblem(status: number, body: unknown): ApiProblem {
  const b = body && typeof body === 'object' ? (body as Partial<ApiProblem>) : {};
  return {
    ...b,
    status,
    code: b.code ?? `http.${status}`,
    title: b.title || messages()[status] || messages().default,
  };
}

export async function api<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown,
  opts: { idempotencyKey?: string; signal?: AbortSignal } = {}): Promise<T> {
  // absolute URL: same origin in the browser; jsdom's http://localhost:3000 in Vitest (undici rejects relative URLs)
  const res = await fetch(new URL(`/bff/v1${path}`, window.location.origin), {
    method,
    headers: { 'content-type': 'application/json', ...(opts.idempotencyKey ? { 'idempotency-key': opts.idempotencyKey } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: opts.signal,
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let json: unknown, parsed = true;
  try { json = text ? JSON.parse(text) : undefined; } catch { json = text; parsed = false; }
  if (!res.ok) throw new ApiError(normalizeProblem(res.status, json));
  if (!parsed) throw new ApiError(normalizeProblem(res.status, { code: 'http.invalid_body' })); // 2xx but not JSON: a proxy / login page, not data
  return json as T;
}
