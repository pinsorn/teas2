import { HttpResponse, http } from 'msw';
import type { Page, PartySummary } from '@/domain/types';
import { ctx, forbidden, screenGate } from './common';

export const partiesHandlers = [
  http.get('*/bff/v1/parties', async ({ request }) => {
    const gate = await screenGate('list');
    if (gate) return gate;
    const { st, company, perms } = ctx();
    if (!perms.includes('party.read')) return forbidden('party.read');
    const u = new URL(request.url);
    const kind = u.searchParams.get('kind');
    const q = (u.searchParams.get('q') ?? '').toLowerCase();
    const limit = Math.min(Number(u.searchParams.get('limit')) || 50, 200);
    const items = st.parties
      .filter((p) => p.companyId === company.id && (!kind || p.kind === kind)
        && (!q || `${p.name} ${p.code} ${p.taxId ?? ''}`.toLowerCase().includes(q)))
      .slice(0, limit).map(({ companyId, ...p }) => { void companyId; return p as PartySummary; });
    return HttpResponse.json({ items } satisfies Page<PartySummary>);
  }),
];
