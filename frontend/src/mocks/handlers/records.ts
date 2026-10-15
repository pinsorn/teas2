import { HttpResponse, http } from 'msw';
import type { RecordRow } from '@/domain/records';
import type { Actor, Page } from '@/domain/types';
import { MockError, logAudit } from '../engine/log';
import { RECORD_IMPLS, type RecordKindImpl } from '../records/registry';
import { saveState } from '../store';
import { ctx, forbidden, problem, screenGate } from './common';

const ACTOR: Actor = { kind: 'user', id: 'u-1', name: 'สมศรี บัญชีดี' };
type Ctx = ReturnType<typeof ctx>;

/** Gate order: screen state, kind, VAT scope, permission. MockError becomes problem+json. */
async function guarded(gateKind: 'list' | 'item', rawKind: unknown, need: 'read' | 'manage', run: (c: Ctx, impl: RecordKindImpl, kind: string) => Response | Promise<Response>) {
  const gate = await screenGate(gateKind);
  if (gate) return gate;
  try {
    const c = ctx();
    const kind = String(rawKind);
    const impl = Object.hasOwn(RECORD_IMPLS, kind) ? RECORD_IMPLS[kind as keyof typeof RECORD_IMPLS] : undefined;
    if (!impl) return problem(404, 'record.kind_unknown', 'ไม่รู้จักข้อมูลหลักประเภทนี้');
    if (impl.vat && impl.vat !== 'both' && (impl.vat === 'vat-only') !== c.company.vatRegistered) {
      return problem(404, 'record.not_available', impl.vat === 'vat-only' ? 'ใช้ได้เฉพาะบริษัทที่จดทะเบียน VAT' : 'ใช้ได้เฉพาะบริษัทที่ไม่ได้จดทะเบียน VAT');
    }
    if (!c.perms.includes(impl.perms[need])) return forbidden(impl.perms[need]);
    return await run(c, impl, kind);
  } catch (e) {
    if (e instanceof MockError) return problem(e.status, e.code, e.title);
    throw e;
  }
}

const bodyOf = async (req: Request): Promise<Record<string, unknown>> => {
  const b: unknown = await req.json().catch(() => undefined);
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new MockError(422, 'record.invalid', 'ข้อมูลไม่ถูกต้อง');
  return b as Record<string, unknown>;
};
const invalid = (fieldErrors: Record<string, string[]>) => problem(422, 'record.invalid', 'ข้อมูลไม่ถูกต้อง ตรวจสอบช่องที่มีเครื่องหมาย', { fieldErrors });
const current = (impl: RecordKindImpl, c: Ctx, id: unknown): RecordRow => {
  const r = impl.rows(c.st, c.company.id).find((x) => x.id === id);
  if (!r) throw new MockError(404, 'record.not_found', 'ไม่พบข้อมูลนี้');
  return r;
};
const conflict = () => problem(409, 'record.version_conflict', 'ข้อมูลนี้ถูกแก้ไขโดยผู้อื่นแล้ว โหลดข้อมูลใหม่ก่อนบันทึก');

export const recordsHandlers = [
  http.get('*/bff/v1/records/:kind', ({ request, params }) => guarded('list', params.kind, 'read', (c, impl) => {
    const u = new URL(request.url);
    const q = (u.searchParams.get('q') ?? '').trim().toLowerCase();
    const active = u.searchParams.get('active') ?? 'true';
    const limit = Math.min(Number(u.searchParams.get('limit')) || 25, 100);
    const offset = u.searchParams.get('cursor') ? Number(atob(u.searchParams.get('cursor')!)) || 0 : 0;
    const rows = impl.rows(c.st, c.company.id)
      .filter((r) => (active === 'all' || r.active === (active !== 'false'))
        && (!q || [r.code, r.name, r.nameEn, r.taxId].some((x) => typeof x === 'string' && x.toLowerCase().includes(q))))
      .sort((a, b) => String(a.code ?? '').localeCompare(String(b.code ?? ''), 'en', { numeric: true }));
    const next = offset + limit;
    return HttpResponse.json({ items: rows.slice(offset, next), total: rows.length, ...(next < rows.length ? { nextCursor: btoa(String(next)) } : {}) } satisfies Page<RecordRow>);
  })),

  http.get('*/bff/v1/records/:kind/:id', ({ params }) => guarded('item', params.kind, 'read', (c, impl) => HttpResponse.json(current(impl, c, params.id)))),

  http.post('*/bff/v1/records/:kind', ({ request, params }) => guarded('item', params.kind, 'manage', async (c, impl, kind) => {
    const values = await bodyOf(request);
    const key = request.headers.get('Idempotency-Key');
    const slot = key ? `${c.company.id}|record:${kind}|${key}` : undefined;
    const seen = slot ? c.st.idempotency?.[slot] : undefined;
    if (seen) return HttpResponse.json(current(impl, c, seen), { status: 201 });
    const errors = impl.validate(values, c.st, c.company.id);
    if (Object.keys(errors).length) return invalid(errors);
    const row = impl.create(c.st, c.company.id, values);
    if (slot) (c.st.idempotency ??= {})[slot] = row.id;
    logAudit(c.st, ACTOR, c.company.id, `record.${kind}.create`, row.id, undefined, row);
    saveState(c.st);
    return HttpResponse.json(row, { status: 201 });
  })),

  http.put('*/bff/v1/records/:kind/:id', ({ request, params }) => guarded('item', params.kind, 'manage', async (c, impl, kind) => {
    const { version, ...values } = await bodyOf(request);
    const before = current(impl, c, params.id);
    if (version !== before.version) return conflict();
    const errors = impl.validate(values, c.st, c.company.id, before.id);
    if (Object.keys(errors).length) return invalid(errors);
    const after = impl.update(c.st, c.company.id, before.id, values);
    logAudit(c.st, ACTOR, c.company.id, `record.${kind}.update`, before.id, before, after);
    saveState(c.st);
    return HttpResponse.json(after);
  })),

  http.post('*/bff/v1/records/:kind/:id/active', ({ request, params }) => guarded('item', params.kind, 'manage', async (c, impl, kind) => {
    const { version, active } = await bodyOf(request);
    if (typeof active !== 'boolean') return problem(422, 'record.invalid', 'ต้องระบุสถานะใช้งาน');
    const before = current(impl, c, params.id);
    if (version !== before.version) return conflict();
    if (before.active === active) return HttpResponse.json(before); // already there: no write, no audit
    const why = active ? undefined : impl.canDeactivate?.(c.st, c.company.id, before.id);
    if (why) return problem(409, 'record.in_use', 'ปิดใช้งานไม่ได้', { detail: why });
    const after = impl.setActive(c.st, c.company.id, before.id, active);
    logAudit(c.st, ACTOR, c.company.id, `record.${kind}.${active ? 'activate' : 'deactivate'}`, before.id, before, after);
    saveState(c.st);
    return HttpResponse.json(after);
  })),
];
