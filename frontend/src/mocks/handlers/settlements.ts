import { HttpResponse, http } from 'msw';
import type { Actor, DepositRow, Page, SettlementRecord } from '@/domain/types';
import { MockError } from '../engine/log';
import { depositsOf, postSettlement, reverseSettlement, type SettleRequest } from '../engine/settlement-records';
import { ctx, forbidden, persist, problem, screenGate } from './common';

const ACTOR: Actor = { kind: 'user', id: 'u-1', name: 'สมศรี บัญชีดี' };
type Ctx = ReturnType<typeof ctx>;
const MANAGE = 'bank.manage';

/** Screen-state gate, one permission check; MockError becomes problem+json. Reading needs `bank.read`, posting and reversing `bank.manage` (the operator reads, the accountant acts). */
async function guarded(gate: 'list' | 'item', perm: string, run: (c: Ctx) => Response | Promise<Response>): Promise<Response> {
  const g = await screenGate(gate);
  if (g) return g;
  try {
    const c = ctx();
    if (!c.perms.includes(perm)) return forbidden(perm);
    return await run(c);
  } catch (e) {
    if (e instanceof MockError) return problem(e.status, e.code, e.title);
    throw e;
  }
}
const mine = (c: Ctx) => c.st.settlements.filter((s) => s.companyId === c.company.id);

export const settlementHandlers = [
  // unapplied customer deposits (RC) and vendor prepayments (PV) with what is left, plus the company's tolerance and the customer / vendor pairs that can be netted
  http.get('*/bff/v1/finance/deposits', () => guarded('list', 'bank.read', (c) => {
    const co = c.company.id;
    const pairs = c.st.parties.filter((p) => p.companyId === co && p.kind === 'customer' && p.linkedPartyId && p.active !== false).flatMap((p) => {
      const v = c.st.parties.find((x) => x.id === p.linkedPartyId && x.companyId === co && x.kind === 'vendor');
      return v ? [{ customerId: p.id, customerName: p.name, vendorId: v.id, vendorName: v.name }] : [];
    });
    return HttpResponse.json({ items: depositsOf(c.st, co), tolerance: c.st.settlementTolerance.find((t) => t.companyId === co) ?? { rounding: '0.00', smallWriteOff: '0.00' }, pairs } satisfies { items: DepositRow[]; tolerance: object; pairs: object[] });
  })),

  http.get('*/bff/v1/finance/settlements', ({ request }) => guarded('list', 'bank.read', (c) => {
    const u = new URL(request.url);
    const q = (u.searchParams.get('q') ?? '').trim().toLowerCase(), status = u.searchParams.get('status') || undefined;
    const limit = Math.min(Number(u.searchParams.get('limit')) || 25, 100);
    const offset = u.searchParams.get('cursor') ? Number(atob(u.searchParams.get('cursor')!)) || 0 : 0;
    const rows = mine(c).filter((s) => (!status || s.status === status)
      && (!q || `${s.id} ${[...s.sources, ...s.targets].map((l) => `${l.number ?? ''} ${l.partyName ?? ''}`).join(' ')}`.toLowerCase().includes(q)))
      .sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
    const next = offset + limit;
    return HttpResponse.json({ items: structuredClone(rows.slice(offset, next)), total: rows.length, ...(next < rows.length ? { nextCursor: btoa(String(next)) } : {}) } satisfies Page<SettlementRecord>);
  })),

  http.get('*/bff/v1/finance/settlements/:id', ({ params }) => guarded('item', 'bank.read', (c) => {
    const s = mine(c).find((x) => x.id === params.id);
    if (!s) throw new MockError(404, 'settlement.not_found', 'ไม่พบรายการหักกลบ');
    return HttpResponse.json(structuredClone(s));
  })),

  http.post('*/bff/v1/finance/settlements', ({ request }) => guarded('item', MANAGE, async (c) => {
    const body = (await request.json().catch(() => undefined)) as SettleRequest | undefined;
    if (!body || typeof body !== 'object') throw new MockError(422, 'settle.invalid_request', 'ข้อมูลรายการไม่ถูกต้อง');
    const key = request.headers.get('Idempotency-Key');
    const slot = key ? `${c.company.id}|settlement|${key}` : undefined;
    const seen = slot ? c.st.idempotency?.[slot] : undefined;
    const prior = seen ? mine(c).find((s) => s.id === seen) : undefined;
    if (prior) return HttpResponse.json(structuredClone(prior), { status: 201 });
    const rec = postSettlement(c.st, c.company.id, body, ACTOR);
    if (slot) (c.st.idempotency ??= {})[slot] = rec.id;
    persist(c.st);
    return HttpResponse.json(rec, { status: 201 });
  })),

  http.post('*/bff/v1/finance/settlements/:id/reverse', ({ request, params }) => guarded('item', MANAGE, async (c) => {
    const body = ((await request.json().catch(() => undefined)) ?? {}) as { reason?: string };
    const rec = reverseSettlement(c.st, c.company.id, String(params.id), ACTOR, typeof body.reason === 'string' ? body.reason : undefined);
    persist(c.st);
    return HttpResponse.json(rec);
  })),
];
