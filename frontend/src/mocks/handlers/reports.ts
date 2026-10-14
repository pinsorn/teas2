import { HttpResponse, http } from 'msw';
import { buildReport, isBuilt, reportCsv } from '../engine/reports';
import { ctx, forbidden, problem, screenGate } from './common';

const PERM = 'report.read';
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Report models are computed here from the journals (D-28); the frontend only lays them out. */
async function run(kind: string, url: URL) {
  const gate = await screenGate('item');
  if (gate) return gate;
  const { st, company, perms, s } = ctx();
  if (!perms.includes(PERM)) return forbidden(PERM);
  if (!isBuilt(kind)) return problem(404, 'report.not_built', 'รายงานนี้ยังไม่เปิดให้ใช้งาน');
  const p = Object.fromEntries(url.searchParams);
  if (p.asOf && !DATE.test(p.asOf)) return problem(422, 'report.bad_param', 'วันที่ไม่ถูกต้อง');
  const model = buildReport(st, company.id, kind, p);
  // the toolbar's "empty" state: a successful report with no rows (never an error)
  return { model: s.screenState === 'empty' ? { ...model, rows: [] } : model };
}

export const reportsHandlers = [
  http.get('*/bff/v1/reports/:kind/export', async ({ request, params }) => {
    const r = await run(String(params.kind), new URL(request.url));
    if (r instanceof Response) return r;
    return new HttpResponse(reportCsv(r.model), { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${params.kind}.csv"` } });
  }),
  http.get('*/bff/v1/reports/:kind', async ({ request, params }) => {
    const r = await run(String(params.kind), new URL(request.url));
    return r instanceof Response ? r : HttpResponse.json(r.model);
  }),
];
