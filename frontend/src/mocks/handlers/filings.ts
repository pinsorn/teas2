import { HttpResponse, http } from 'msw';
import type { FilingForm } from '@/domain/filings';
import type { Actor } from '@/domain/types';
import { exportFilingText, filingHistory, finalizeFiling, getFiling } from '../engine/filings';
import { nextMonth, prevMonth } from '../engine/filings/pp30';
import { openClaimMonth } from '../engine/purchase-vat';
import { MockError, today } from '../engine/log';
import { ctx, forbidden, persist, problem, screenGate } from './common';

const ACTOR: Actor = { kind: 'user', id: 'u-1', name: 'สมศรี บัญชีดี' };
const READ = 'tax.read', PREVIEW = 'tax.filing.preview', FINALIZE = 'tax.filing.finalize';

/** TX1 tax filings: the finalized filings of a form with the month to look at next (`tax.read`), one period (`tax.read`; a draft also needs `tax.filing.preview`), finalize (`tax.filing.finalize`), and the RD Prep text of a finalized one. MockError becomes problem+json. */
async function act(perm: string, run: (c: ReturnType<typeof ctx>) => unknown, write = false): Promise<Response> {
  const gate = await screenGate('item');
  if (gate) return gate;
  try {
    const c = ctx();
    if (perm && !c.perms.includes(perm)) return forbidden(perm);
    const out = run(c);
    if (write) persist(c.st);
    return out instanceof Response ? out : HttpResponse.json(out as never);
  } catch (e) {
    if (e instanceof MockError) return problem(e.status, e.code, e.title);
    throw e;
  }
}
const form = (p: unknown) => String(p) as FilingForm;

export const filingHandlers = [
  /** R2-3: the claim period the server stores at issue for a bill with these dates (the first unfiled month of its window, else the document month); any signed-in role, it reveals no filing content. */
  http.get('*/bff/v1/claim-period', ({ request }) => act('', (c) => {
    const q = new URL(request.url).searchParams, dd = q.get('documentDate') ?? '';
    return { claimPeriod: openClaimMonth(c.st, c.company.id, dd, q.get('vendorDocDate') || undefined) ?? dd.slice(0, 7) };
  })),
  http.get('*/bff/v1/filings/:form/:period/export', ({ params }) => act(READ, (c) => new HttpResponse(exportFilingText(c.st, c.company.id, form(params.form), String(params.period)), { headers: { 'content-type': 'text/plain; charset=utf-8', 'content-disposition': `attachment; filename="${params.form}-${params.period}.txt"` } }))),
  http.get('*/bff/v1/filings/:form/:period', ({ params }) => act(READ, (c) => {
    const m = getFiling(c.st, c.company.id, form(params.form), String(params.period));
    if (m.status === 'draft' && !c.perms.includes(PREVIEW)) throw new MockError(403, 'auth.forbidden', 'คุณไม่มีสิทธิ์ดูข้อมูลนี้');
    return c.s.screenState === 'empty' ? { ...m, boxes: [], tieOuts: [], blockers: [] } : m; // the toolbar's "empty": a successful answer with nothing in it
  })),
  http.get('*/bff/v1/filings/:form', ({ params }) => act(READ, (c) => {
    getFiling(c.st, c.company.id, form(params.form), prevMonth(today().slice(0, 7))); // 404 filing.not_available for a company outside VAT
    const items = filingHistory(c.st, c.company.id, form(params.form));
    return { items, next: items[0] ? nextMonth(items[0].period) : prevMonth(today().slice(0, 7)) };
  })),
  http.post('*/bff/v1/filings/:form/:period/finalize', async ({ request, params }) => {
    const b = (await request.json().catch(() => ({}))) as { version?: number };
    return act(FINALIZE, (c) => finalizeFiling(c.st, c.company.id, form(params.form), String(params.period), Number(b.version), ACTOR), true);
  }),
];
