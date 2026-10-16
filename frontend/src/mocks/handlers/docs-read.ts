import { DOC_TYPES, LIVE, isTypeAvailable } from '@/domain/doc-types';
import { HttpResponse, http } from 'msw';
import type { Doc, DocType, DocSummary, Lock, OpenItem, Page } from '@/domain/types';
import { ctx, forbidden, problem, screenGate } from './common';

import { recomputeSettlement, unavailableTh } from '../engine/commands';
import { approvalRequired } from '../engine/approval';
import { payoutOf } from '../engine/settlement';
import { printCountOf } from '../engine/attachments';
import { progressOf } from '../engine/chain';
import { today } from '../engine/log';
import { derivedLocks } from '../engine/locks';
import { balanceOf } from '../engine/settlement';
import { fromSatang } from '../engine/money';
import { isVendorBill } from '../engine/purchase-vat';

const LOCKED: Lock = { kind: 'filing', reason: 'ภ.พ.30 เดือน ก.ย. 2569 ยื่นแล้ว', exits: ['ออกใบลดหนี้ / ใบเพิ่มหนี้ในงวดถัดไป'] };
const LOCKABLE = ['issued', 'partly_settled', 'settled'];

const progressField = (st: Parameters<typeof progressOf>[0], d: Doc) => { const p = progressOf(st, d); return p ? { progress: p } : {}; };
export const toSummary = (d: Doc): DocSummary => ({
  id: d.id, type: d.type, number: d.number, status: d.status, documentDate: d.header.documentDate, partyName: d.party?.name ?? '',
  total: d.totals.total, outstanding: d.outstanding, dueDate: d.header.dueDate, reference: (isVendorBill(d.type) && d.header.vendorDocNumber) || d.header.reference, createdByAgent: d.createdBy.kind === 'agent', // a vendor's document is found by the number printed on it
  ...(d.marks ? { marks: d.marks } : {}),
});

export const docsReadHandlers = [
  // registered before `/docs/:type` so "open-items" is never read as a document type.
  // Permission: doc.<T>.read for every requested type this company has (a type the company cannot use, e.g. IV for a VAT company, is skipped).
  http.get('*/bff/v1/docs/open-items', async ({ request }) => {
    const gate = await screenGate('item');
    if (gate) return gate;
    const { st, company, perms } = ctx();
    const u = new URL(request.url);
    const partyId = u.searchParams.get('partyId');
    const asked = (u.searchParams.get('types') ?? '').split(',').filter(Boolean);
    if (!partyId || !asked.length || asked.some((t) => !Object.hasOwn(DOC_TYPES, t) || !DOC_TYPES[t as DocType].outstanding)) {
      return problem(422, 'doc.open_items_query', 'ต้องระบุคู่ค้าและประเภทเอกสารที่มียอดค้างชำระ');
    }
    const types = (asked as DocType[]).filter((t) => isTypeAvailable(t, company.vatRegistered));
    for (const t of types) if (!perms.includes(`doc.${t}.read`)) return forbidden(`doc.${t}.read`);
    const rows = st.docs
      .filter((d) => d.companyId === company.id && d.header.partyId === partyId && types.includes(d.type) && LIVE.includes(d.status) && balanceOf(st, d).out !== 0)
      .sort((a, b) => a.header.documentDate.localeCompare(b.header.documentDate) || (a.number ?? '').localeCompare(b.number ?? ''));
    const items = rows.map((d): OpenItem => ({ id: d.id, type: d.type, number: d.number ?? '', documentDate: d.header.documentDate, ...(d.header.dueDate ? { dueDate: d.header.dueDate } : {}),
        total: d.totals.total, outstanding: fromSatang(balanceOf(st, d).out) }));
    const total = fromSatang(rows.reduce((a, d) => a + balanceOf(st, d).out, 0)); // the server's sum: the browser never adds money
    return HttpResponse.json({ items, total });
  }),
  // a party's documents across every type the role can read (registered before  like open-items)
  http.get('*/bff/v1/docs/by-party/:partyId', async ({ params }) => {
    const gate = await screenGate('list');
    if (gate) return gate;
    const { st, company, perms } = ctx();
    if (!st.parties.some((p) => p.id === params.partyId && p.companyId === company.id)) return problem(404, 'record.not_found', 'ไม่พบข้อมูลนี้');
    // a type the company cannot use or the role cannot read is skipped, not a failure: the tab shows what the role may see
    const rows = st.docs
      .filter((d) => d.companyId === company.id && d.header.partyId === params.partyId && isTypeAvailable(d.type, company.vatRegistered) && perms.includes(`doc.${d.type}.read`))
      .sort((a, b) => b.header.documentDate.localeCompare(a.header.documentDate) || (a.number ?? '').localeCompare(b.number ?? ''));
    return HttpResponse.json({ items: rows.map(toSummary), total: rows.length } satisfies Page<DocSummary>);
  }),
  http.get('*/bff/v1/docs/:type', async ({ request, params }) => {
    const gate = await screenGate('list');
    if (gate) return gate;
    const rawType = String(params.type);
    if (!Object.hasOwn(DOC_TYPES, rawType)) return problem(404, 'doc.type_not_available', 'ไม่รู้จักประเภทเอกสารนี้');
    const type = rawType as DocType;
    const { st, company, perms } = ctx();
    if (!isTypeAvailable(type, company.vatRegistered)) return problem(404, 'doc.type_not_available', unavailableTh(type));
    if (!perms.includes(`doc.${type}.read`)) return forbidden(`doc.${type}.read`);
    const u = new URL(request.url);
    const statuses = u.searchParams.get('status')?.split(',').filter(Boolean), from = u.searchParams.get('from'), to = u.searchParams.get('to');
    const q = (u.searchParams.get('q') ?? '').toLowerCase(), owing = u.searchParams.get('outstanding') === 'positive';
    const overdue = u.searchParams.get('overdue') === '1', agent = u.searchParams.get('agent') === '1', now = today();
    const limit = Math.min(Number(u.searchParams.get('limit')) || 25, 100);
    const offset = u.searchParams.get('cursor') ? Number(atob(u.searchParams.get('cursor')!)) || 0 : 0;
    const rows = st.docs
      .filter((d) => d.companyId === company.id && d.type === type && (!statuses?.length || statuses.includes(d.status))
        && (!owing || Number(d.outstanding ?? 0) > 0)
        && (!overdue || (!!d.header.dueDate && d.header.dueDate < now && Number(d.outstanding ?? 0) > 0)) && (!agent || d.createdBy.kind === 'agent') && (!from || d.header.documentDate >= from) && (!to || d.header.documentDate <= to)
        && (!q || `${d.number ?? ''} ${d.party?.name ?? ''} ${d.header.vendorDocNumber ?? ''}`.toLowerCase().includes(q)))
      .sort((a, b) => b.header.documentDate.localeCompare(a.header.documentDate) || (a.number ?? '').localeCompare(b.number ?? ''));
    const items = rows.slice(offset, offset + limit).map((d) => ({ ...toSummary(d), ...progressField(st, d) }));
    const next = offset + limit;
    return HttpResponse.json({ items, total: rows.length, ...(next < rows.length ? { nextCursor: btoa(String(next)) } : {}) } satisfies Page<DocSummary>);
  }),
  http.get('*/bff/v1/docs/:type/:id', async ({ params }) => {
    const gate = await screenGate('item');
    if (gate) return gate;
    const rawType = String(params.type);
    if (!Object.hasOwn(DOC_TYPES, rawType)) return problem(404, 'doc.type_not_available', 'ไม่รู้จักประเภทเอกสารนี้');
    const type = rawType as DocType;
    const { st, s, company, perms } = ctx();
    if (!isTypeAvailable(type, company.vatRegistered)) return problem(404, 'doc.type_not_available', unavailableTh(type));
    if (!perms.includes(`doc.${type}.read`)) return forbidden(`doc.${type}.read`);
    const found = st.docs.find((d) => d.id === params.id && d.type === type && d.companyId === company.id);
    if (!found) return problem(404, 'doc.not_found', 'ไม่พบเอกสาร');
    recomputeSettlement(st, found.id);
    const cur = st.docs.find((d) => d.id === found.id)!;
    const { companyId, ...doc } = cur; void companyId;
    const own = derivedLocks(st, cur);
    const locks = s.screenState === 'locked' && LOCKABLE.includes(doc.status) && !own.some((l) => l.kind === 'filing') ? [...own, LOCKED] : own;
    const progress = progressOf(st, cur);
    const printCount = printCountOf(st, cur.id);
    return HttpResponse.json({ ...doc, locks, ...(progress && ['SO', 'DO', 'PO'].includes(cur.type) ? { progress } : {}), ...(printCount ? { printCount } : {}),
      ...(cur.status === 'draft' && approvalRequired(st, company.id, cur.type, payoutOf(st, company.id, cur)) ? { approvalRequired: true } : {}) } satisfies Doc);
  }),
];
