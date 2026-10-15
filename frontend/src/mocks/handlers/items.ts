import { HttpResponse, http } from 'msw';
import type { ItemSummary, Page } from '@/domain/types';
import { ctx, forbidden, problem, screenGate } from './common';

/**
 * Type-ahead for document lines. Inactive items are never offered (their old documents keep the line they were issued with);
 * `?usage=sales|purchase` keeps the items usable on that side; no `usage` = every active item.
 */
export const itemsHandlers = [
  http.get('*/bff/v1/items', async ({ request }) => {
    const gate = await screenGate('list');
    if (gate) return gate;
    const { st, company, perms } = ctx();
    if (!perms.includes('item.read')) return forbidden('item.read');
    const u = new URL(request.url);
    const q = (u.searchParams.get('q') ?? '').toLowerCase();
    const usage = u.searchParams.get('usage');
    if (usage !== null && usage !== 'sales' && usage !== 'purchase') return problem(422, 'items.invalid_usage', 'usage ต้องเป็น sales หรือ purchase');
    const limit = Math.min(Number(u.searchParams.get('limit')) || 50, 200);
    const items = st.items
      .filter((i) => i.companyId === company.id && i.active !== false && (!usage || i.usage[usage]) && (!q || `${i.name} ${i.code}`.toLowerCase().includes(q)))
      .slice(0, limit).map(({ companyId, version, ...i }) => { void companyId; void version; return i as ItemSummary; });
    return HttpResponse.json({ items } satisfies Page<ItemSummary>);
  }),
];
