import { HttpResponse, http } from 'msw';
import type { Actor } from '@/domain/types';
import { MockError } from '../engine/log';
import { runSchedule, scheduleOf, stopSchedule } from '../engine/schedules';
import { toRow } from '../records/schedules';
import { ctx, forbidden, persist, problem, screenGate } from './common';

const ACTOR: Actor = { kind: 'user', id: 'u-1', name: 'สมศรี บัญชีดี' };
const MANAGE = 'ledger.schedule.manage';

/** AC4: "รันตอนนี้" (the mock scheduler) and "หยุด". Both need `ledger.schedule.manage`; `version` (when sent) is the record kit's concurrency check. MockError becomes problem+json. */
async function act(req: Request, id: unknown, run: (c: ReturnType<typeof ctx>, body: { version?: number; month?: string; reason?: string }) => unknown): Promise<Response> {
  const gate = await screenGate('item');
  if (gate) return gate;
  try {
    const c = ctx();
    if (!c.perms.includes(MANAGE)) return forbidden(MANAGE);
    const body = ((await req.json().catch(() => ({}))) ?? {}) as { version?: number; month?: string; reason?: string };
    const s = scheduleOf(c.st, c.company.id, String(id));
    if (body.version !== undefined && body.version !== s.version) return problem(409, 'record.version_conflict', 'ข้อมูลนี้ถูกแก้ไขโดยผู้อื่นแล้ว โหลดข้อมูลใหม่ก่อนบันทึก');
    run(c, body);
    persist(c.st);
    return HttpResponse.json(toRow(c.st, s));
  } catch (e) {
    if (e instanceof MockError) return problem(e.status, e.code, e.title);
    throw e;
  }
}

export const scheduleHandlers = [
  http.post('*/bff/v1/schedules/:id/run', ({ request, params }) => act(request, params.id, (c, b) => runSchedule(c.st, c.company.id, String(params.id), ACTOR, b.month ? { month: b.month } : undefined))),
  http.post('*/bff/v1/schedules/:id/stop', ({ request, params }) => act(request, params.id, (c, b) => stopSchedule(c.st, c.company.id, String(params.id), ACTOR, typeof b.reason === 'string' ? b.reason : undefined))),
];
