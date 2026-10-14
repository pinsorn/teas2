import type { ApiProblem } from '@/domain/types';

export class ApiError extends Error {
  constructor(public problem: ApiProblem) { super(problem.title); }
  get code() { return this.problem.code; }
}

const FALLBACK: Record<number, string> = {
  400: 'ข้อมูลไม่ถูกต้อง', 401: 'กรุณาเข้าสู่ระบบอีกครั้ง', 403: 'คุณไม่มีสิทธิ์ทำรายการนี้',
  404: 'ไม่พบข้อมูลที่ต้องการ', 409: 'ข้อมูลถูกแก้ไขโดยผู้อื่น โหลดใหม่แล้วลองอีกครั้ง',
};

export function normalizeProblem(status: number, body: unknown): ApiProblem {
  const b = body && typeof body === 'object' ? (body as Partial<ApiProblem>) : {};
  return {
    ...b,
    status,
    code: b.code ?? `http.${status}`,
    title: b.title || FALLBACK[status] || 'เชื่อมต่อระบบไม่สำเร็จ ลองใหม่อีกครั้ง',
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
  let json: unknown;
  try { json = text ? JSON.parse(text) : undefined; } catch { json = text; }
  if (!res.ok) throw new ApiError(normalizeProblem(res.status, json));
  return json as T;
}
