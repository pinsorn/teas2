import { HttpResponse, http } from 'msw';
import type { ItemSummary, Page } from '@/domain/types';
import { ctx, forbidden, screenGate } from './index';

export const itemsHandlers = [
  http.get('*/bff/v1/items', async ({ request }) => {
    const gate = await screenGate('list');
    if (gate) return gate;
    const { st, company, perms } = ctx();
    if (!perms.includes('item.read')) return forbidden('item.read');
    const u = new URL(request.url);
    const q = (u.searchParams.get('q') ?? '').toLowerCase();
    const limit = Math.min(Number(u.searchParams.get('limit')) || 50, 200);
    const items = st.items
      .filter((i) => i.companyId === company.id && (!q || `${i.name} ${i.code}`.toLowerCase().includes(q)))
      .slice(0, limit).map(({ companyId, ...i }) => { void companyId; return i as ItemSummary; });
    return HttpResponse.json({ items } satisfies Page<ItemSummary>);
  }),
];
