import { HttpResponse, delay } from 'msw';
import type { ApiProblem } from '@/domain/types';
import { PERMISSIONS_BY_ROLE } from '../permissions';
import { getSettings } from '../settings';
import { MockError } from '../engine/log';
import { loadState, saveState } from '../store';

export const problem = (status: number, code: string, title: string, extra: Partial<ApiProblem> = {}) =>
  HttpResponse.json({ type: 'about:blank', status, code, title, traceId: `mock-${code}`, ...extra } satisfies ApiProblem,
    { status, headers: { 'content-type': 'application/problem+json' } });

export function ctx() {
  const st = loadState();
  const s = getSettings();
  const company = st.companies.find((c) => (s.companyKey === 'vat' ? c.vatRegistered : !c.vatRegistered))!;
  return { st, s, company, perms: PERMISSIONS_BY_ROLE[s.role] };
}

/** Applies the toolbar's screen state. Returns a response to short-circuit, or null to continue. */
/** `me` is the session, not screen content: "forbidden" / "empty" leave it alone so the shell (nav, company) still renders around the forbidden screen. */
export async function screenGate(kind: 'list' | 'item' | 'me') {
  const { s } = ctx();
  if (s.screenState === 'loading') { await delay('infinite'); }
  if (s.screenState === 'error') return problem(500, 'mock.server_error', 'ระบบขัดข้องชั่วคราว ลองใหม่อีกครั้ง');
  if (s.screenState === 'forbidden' && kind !== 'me') return problem(403, 'auth.forbidden', 'คุณไม่มีสิทธิ์ดูข้อมูลนี้');
  if (s.screenState === 'empty' && kind === 'list') return HttpResponse.json({ items: [] });
  return null;
}

export const forbidden = (perm: string) =>
  problem(403, 'auth.forbidden', 'คุณไม่มีสิทธิ์ดูข้อมูลนี้', { detail: `ต้องมีสิทธิ์ ${perm}` });

/** Persists a write. A browser that refuses it (quota) must not be told "done": the command fails with 507 and the previously stored state stays as it was. */
export function persist(st: Parameters<typeof saveState>[0]): void {
  if (!saveState(st)) throw new MockError(507, 'storage.full', 'พื้นที่เก็บข้อมูลตัวอย่างเต็ม — ลบไฟล์แนบหรือรีเซ็ตข้อมูลตัวอย่าง');
}
