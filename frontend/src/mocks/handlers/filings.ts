import { HttpResponse, http } from 'msw';
import type { FilingForm } from '@/domain/filings';
import type { Actor } from '@/domain/types';
import { citYearView, isCit, removeCitAdjustment, saveCitAdjustment, updateCitYear } from '../engine/filings/cit';
import { exportFilingText, filingHistory, finalizeFiling, getFiling } from '../engine/filings';
import { nextMonth, prevMonth } from '../engine/filings/pp30';
import { employeeCertificates } from '../engine/filings/pnd1a';
import { formCatalogue } from '../engine/reports/tax-summary';
import { vatThresholdWatch } from '../engine/vat-threshold';
import { taxPaymentLines } from '../engine/reconcile';
import { openClaimMonth } from '../engine/purchase-vat';
import { MockError, today } from '../engine/log';
import { ctx, forbidden, persist, problem, screenGate } from './common';

const ACTOR: Actor = { kind: 'user', id: 'u-1', name: 'สมศรี บัญชีดี' };
const READ = 'tax.read', PREVIEW = 'tax.filing.preview', FINALIZE = 'tax.filing.finalize', RECONCILE = 'bank.reconcile', PAYROLL_READ = 'payroll.read';
/** PY3 ruling 9: the payroll returns (ภ.ง.ด.1 / ภ.ง.ด.1ก / สปส.1-10) are read with `payroll.read`; every other return with `tax.read`. Finalize is the same right for all (accountant). */
const readOf = (f: unknown) => (['PND1', 'PND1A', 'SSO1-10'].includes(String(f)) ? PAYROLL_READ : READ);

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
  // TX3b: the form catalogue with the filing history across forms (tax.read), and the VAT threshold watch (null for a VAT company; any signed-in role that may read tax)
  http.get('*/bff/v1/form-catalogue', () => act(READ, (c) => { const m = formCatalogue(c.st, c.company.id, c.perms.includes(PAYROLL_READ)); return c.s.screenState === 'empty' ? { ...m, forms: [], history: [] } : m; })),
  http.get('*/bff/v1/vat-threshold', () => act(READ, (c) => vatThresholdWatch(c.st, c.company.id))),
  http.get('*/bff/v1/filings/PND1A/:year/certificates', ({ params }) => act(PAYROLL_READ, (c) => (c.s.screenState === 'empty' ? [] : employeeCertificates(c.st, c.company.id, String(params.year))))), // PY3 ruling 8: the 50 ทวิ of the employees, from the finalized ภ.ง.ด.1ก
  http.get('*/bff/v1/filings/:form/:period/export', ({ params }) => act(readOf(params.form), (c) => new HttpResponse(exportFilingText(c.st, c.company.id, form(params.form), String(params.period)), { headers: { 'content-type': 'text/plain; charset=utf-8', 'content-disposition': `attachment; filename="${params.form}-${params.period}.txt"` } }))),
  // TX2c: the statement lines a finalized return can be paid from (bank.reconcile: choosing one posts a bank line)
  http.get('*/bff/v1/filings/:form/:period/payment-lines', ({ params }) => act(RECONCILE, (c) => taxPaymentLines(c.st, c.company.id, form(params.form), String(params.period)))),
  http.get('*/bff/v1/filings/:form/:period', ({ params }) => act(readOf(params.form), (c) => {
    const m = getFiling(c.st, c.company.id, form(params.form), String(params.period));
    if (m.status === 'draft' && !c.perms.includes(PREVIEW)) throw new MockError(403, 'auth.forbidden', 'คุณไม่มีสิทธิ์ดูข้อมูลนี้');
    return c.s.screenState === 'empty' ? { ...m, boxes: [], tieOuts: [], blockers: [] } : m; // the toolbar's "empty": a successful answer with nothing in it
  })),
  http.get('*/bff/v1/filings/:form', ({ params }) => act(readOf(params.form), (c) => {
    if (isCit(form(params.form)) || params.form === 'PND1A') { // TX3a: the year forms; `next` = the year after the last one finalized, else the last year that ended
      const items = filingHistory(c.st, c.company.id, form(params.form));
      return { items, next: items[0] ? String(Number(items[0].period) + 1) : String(Number(today().slice(0, 4)) - 1) }; // PND1A: the same (the year after the last filed, else the last year that ended)
    }
    getFiling(c.st, c.company.id, form(params.form), prevMonth(today().slice(0, 7))); // 404 filing.not_available for a company outside VAT
    const items = filingHistory(c.st, c.company.id, form(params.form));
    return { items, next: items[0] ? nextMonth(items[0].period) : prevMonth(today().slice(0, 7)) };
  })),
  // TX3a: the CIT year data (read: tax.read; write: tax.filing.finalize, the right to file) and the user adjustments
  http.get('*/bff/v1/cit-years/:year', ({ params }) => act(READ, (c) => citYearView(c.st, c.company.id, String(params.year)))),
  http.put('*/bff/v1/cit-years/:year', async ({ request, params }) => { const b = await request.json().catch(() => ({})); return act(FINALIZE, (c) => updateCitYear(c.st, c.company.id, String(params.year), b as never, ACTOR), true); }),
  http.post('*/bff/v1/cit-years/:year/adjustments', async ({ request, params }) => { const b = await request.json().catch(() => ({})); return act(FINALIZE, (c) => saveCitAdjustment(c.st, c.company.id, String(params.year), b as never, ACTOR), true); }),
  http.put('*/bff/v1/cit-years/:year/adjustments/:id', async ({ request, params }) => { const b = await request.json().catch(() => ({})); return act(FINALIZE, (c) => saveCitAdjustment(c.st, c.company.id, String(params.year), b as never, ACTOR, String(params.id)), true); }),
  http.delete('*/bff/v1/cit-years/:year/adjustments/:id', ({ params }) => act(FINALIZE, (c) => removeCitAdjustment(c.st, c.company.id, String(params.year), String(params.id), ACTOR), true)),
  http.post('*/bff/v1/filings/:form/:period/finalize', async ({ request, params }) => {
    const b = (await request.json().catch(() => ({}))) as { version?: number; ack?: boolean };
    return act(FINALIZE, (c) => finalizeFiling(c.st, c.company.id, form(params.form), String(params.period), Number(b.version), ACTOR, b.ack === true), true);
  }),
];
