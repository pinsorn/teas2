import { HttpResponse, http } from 'msw';
import type { Doc, DocSummary, Lock, Page } from '@/domain/types';
import { ctx, forbidden, problem, screenGate } from './common';

const VAT_ONLY = ['TI'];
const LOCKED: Lock = { kind: 'filing', reason: 'ภ.พ.30 เดือน ก.ย. 2569 ยื่นแล้ว', exits: ['ออกใบลดหนี้ / ใบเพิ่มหนี้ในงวดถัดไป'] };
const LOCKABLE = ['issued', 'partly_settled', 'settled'];

export const toSummary = (d: Doc): DocSummary => ({
  id: d.id, type: d.type, number: d.number, status: d.status, documentDate: d.header.documentDate, partyName: d.party?.name ?? '',
  total: d.totals.total, outstanding: d.outstanding, dueDate: d.header.dueDate, createdByAgent: d.createdBy.kind === 'agent',
});

export const docsReadHandlers = [
  http.get('*/bff/v1/docs/:type', async ({ request, params }) => {
    const gate = await screenGate('list');
    if (gate) return gate;
    const type = String(params.type);
    const { st, company, perms } = ctx();
    if (VAT_ONLY.includes(type) && !company.vatRegistered) return problem(404, 'doc.type_not_available', 'บริษัทนี้ไม่ได้จดทะเบียนภาษีมูลค่าเพิ่ม');
    if (!perms.includes(`doc.${type}.read`)) return forbidden(`doc.${type}.read`);
    const u = new URL(request.url);
    const statuses = u.searchParams.get('status')?.split(',').filter(Boolean), from = u.searchParams.get('from'), to = u.searchParams.get('to');
    const q = (u.searchParams.get('q') ?? '').toLowerCase(), owing = u.searchParams.get('outstanding') === 'positive';
    const limit = Math.min(Number(u.searchParams.get('limit')) || 25, 100);
    const offset = u.searchParams.get('cursor') ? Number(atob(u.searchParams.get('cursor')!)) || 0 : 0;
    const rows = st.docs
      .filter((d) => d.companyId === company.id && d.type === type && (!statuses?.length || statuses.includes(d.status))
        && (!owing || Number(d.outstanding ?? 0) > 0) && (!from || d.header.documentDate >= from) && (!to || d.header.documentDate <= to)
        && (!q || `${d.number ?? ''} ${d.party?.name ?? ''}`.toLowerCase().includes(q)))
      .sort((a, b) => b.header.documentDate.localeCompare(a.header.documentDate) || (a.number ?? '').localeCompare(b.number ?? ''));
    const items = rows.slice(offset, offset + limit).map(toSummary);
    const next = offset + limit;
    return HttpResponse.json({ items, total: rows.length, ...(next < rows.length ? { nextCursor: btoa(String(next)) } : {}) } satisfies Page<DocSummary>);
  }),
  http.get('*/bff/v1/docs/:type/:id', async ({ params }) => {
    const gate = await screenGate('item');
    if (gate) return gate;
    const type = String(params.type);
    const { st, s, company, perms } = ctx();
    if (VAT_ONLY.includes(type) && !company.vatRegistered) return problem(404, 'doc.type_not_available', 'บริษัทนี้ไม่ได้จดทะเบียนภาษีมูลค่าเพิ่ม');
    if (!perms.includes(`doc.${type}.read`)) return forbidden(`doc.${type}.read`);
    const found = st.docs.find((d) => d.id === params.id && d.type === type && d.companyId === company.id);
    if (!found) return problem(404, 'doc.not_found', 'ไม่พบเอกสาร');
    const { companyId, ...doc } = found; void companyId;
    const locks = s.screenState === 'locked' && LOCKABLE.includes(doc.status) && !doc.locks.some((l) => l.kind === 'filing') ? [...doc.locks, LOCKED] : doc.locks;
    return HttpResponse.json({ ...doc, locks } satisfies Doc);
  }),
];
