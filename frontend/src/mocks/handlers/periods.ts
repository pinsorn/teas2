import { HttpResponse, http } from 'msw';
import type { Actor } from '@/domain/types';
import { checklistOf, closePeriod, closeYear, periodsView, reopenPeriod, reopenYear } from '../engine/close';
import { MockError } from '../engine/log';
import { ctx, forbidden, persist, problem, screenGate } from './common';

const ACTOR: Actor = { kind: 'user', id: 'u-1', name: 'สมศรี บัญชีดี' };
const READ = 'ledger.read', CLOSE = 'ledger.period.close', REOPEN = 'ledger.period.reopen';

/** AC6 period close: the year's months, a month's checklist (ledger.read), close (ledger.period.close) and reopen (ledger.period.reopen, with a reason) of a month and of a year. MockError becomes problem+json. */
async function act(perm: string, run: (c: ReturnType<typeof ctx>) => unknown): Promise<Response> {
  const gate = await screenGate('item');
  if (gate) return gate;
  try {
    const c = ctx();
    if (!c.perms.includes(perm)) return forbidden(perm);
    const out = run(c);
    if (perm !== READ) persist(c.st);
    return HttpResponse.json(out as never);
  } catch (e) {
    if (e instanceof MockError) return problem(e.status, e.code, e.title);
    throw e;
  }
}
const body = async (req: Request) => ((await req.json().catch(() => ({}))) ?? {}) as { acknowledge?: { code: string; count: number }[]; reason?: string };

export const periodHandlers = [
  http.get('*/bff/v1/periods/checklist', ({ request }) => act(READ, (c) => ({ items: checklistOf(c.st, c.company.id, new URL(request.url).searchParams.get('month') ?? '') }))),
  http.get('*/bff/v1/periods', ({ request }) => act(READ, (c) => periodsView(c.st, c.company.id, Number(new URL(request.url).searchParams.get('year')) || Number(c.st.periods.find((p) => p.companyId === c.company.id && p.status === 'open')?.month.slice(0, 4)) || 0))),
  http.post('*/bff/v1/periods/year/:year/close', ({ params }) => act(CLOSE, (c) => { closeYear(c.st, c.company.id, Number(params.year), ACTOR); return periodsView(c.st, c.company.id, Number(params.year)); })),
  http.post('*/bff/v1/periods/year/:year/reopen', async ({ request, params }) => { const b = await body(request); return act(REOPEN, (c) => { reopenYear(c.st, c.company.id, Number(params.year), ACTOR, b.reason ?? ''); return periodsView(c.st, c.company.id, Number(params.year)); }); }),
  http.post('*/bff/v1/periods/:month/close', async ({ request, params }) => { const b = await body(request); return act(CLOSE, (c) => { closePeriod(c.st, c.company.id, String(params.month), ACTOR, { acknowledge: Array.isArray(b.acknowledge) ? b.acknowledge : [] }); return periodsView(c.st, c.company.id, Number(String(params.month).slice(0, 4))); }); }),
  http.post('*/bff/v1/periods/:month/reopen', async ({ request, params }) => { const b = await body(request); return act(REOPEN, (c) => { reopenPeriod(c.st, c.company.id, String(params.month), ACTOR, b.reason ?? ''); return periodsView(c.st, c.company.id, Number(String(params.month).slice(0, 4))); }); }),
];
