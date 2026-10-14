import { HttpResponse, delay } from 'msw';
import type { ApiProblem } from '@/domain/types';
import { PERMISSIONS_BY_ROLE } from '../permissions';
import { getSettings } from '../settings';
import { loadState } from '../store';
import { docsReadHandlers } from './docs-read';
import { homeHandlers } from './home';
import { itemsHandlers } from './items';
import { meHandlers } from './me';
import { partiesHandlers } from './parties';
import { searchHandlers } from './search';

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
export async function screenGate(kind: 'list' | 'item') {
  const { s } = ctx();
  if (s.screenState === 'loading') { await delay('infinite'); }
  if (s.screenState === 'error') return problem(500, 'mock.server_error', 'ระบบขัดข้องชั่วคราว ลองใหม่อีกครั้ง');
  if (s.screenState === 'forbidden') return problem(403, 'auth.forbidden', 'คุณไม่มีสิทธิ์ดูข้อมูลนี้');
  if (s.screenState === 'empty' && kind === 'list') return HttpResponse.json({ items: [] });
  return null;
}

export const forbidden = (perm: string) =>
  problem(403, 'auth.forbidden', 'คุณไม่มีสิทธิ์ดูข้อมูลนี้', { detail: `ต้องมีสิทธิ์ ${perm}` });

export const handlers = [...meHandlers, ...homeHandlers, ...partiesHandlers, ...itemsHandlers, ...docsReadHandlers, ...searchHandlers];
