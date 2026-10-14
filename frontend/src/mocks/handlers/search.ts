import { HttpResponse, http } from 'msw';
import type { SearchHit } from '@/domain/types';
import { ctx, screenGate } from './index';

const BASE: Record<string, string> = {
  QT: '/sales/quotations', SO: '/sales/orders', DO: '/sales/delivery-notes', TI: '/sales/tax-invoices', RC: '/sales/receipts', CN: '/sales/credit-notes',
};
const PAGES: { label: string; href: string }[] = [
  { label: 'หน้าหลัก', href: '/' }, { label: 'ใบกำกับภาษี', href: '/sales/tax-invoices' }, { label: 'ใบเสนอราคา', href: '/sales/quotations' },
  { label: 'ใบเสร็จรับเงิน', href: '/sales/receipts' }, { label: 'ลูกค้า', href: '/contacts/customers' }, { label: 'สินค้าและบริการ', href: '/items' },
];

export const searchHandlers = [
  http.get('*/bff/v1/search', async ({ request }) => {
    const gate = await screenGate('list');
    if (gate) return gate;
    const { st, company, perms } = ctx();
    const q = (new URL(request.url).searchParams.get('q') ?? '').trim().toLowerCase();
    if (!q) return HttpResponse.json({ items: [] });
    const docs: SearchHit[] = st.docs
      .filter((d) => d.companyId === company.id && d.number && d.number.toLowerCase().startsWith(q) && perms.includes(`doc.${d.type}.read`))
      .slice(0, 5).map((d) => ({ kind: 'doc', id: d.id, label: `${d.number} · ${d.party?.name ?? ''}`, href: `${BASE[d.type] ?? '/'}/${d.id}` }));
    const parties: SearchHit[] = perms.includes('party.read')
      ? st.parties.filter((p) => p.companyId === company.id && p.name.toLowerCase().includes(q)).slice(0, 5)
        .map((p) => ({ kind: 'party', id: p.id, label: p.name, href: `/contacts/${p.kind === 'customer' ? 'customers' : 'vendors'}/${p.id}` }))
      : [];
    const pages: SearchHit[] = PAGES.filter((p) => p.label.toLowerCase().includes(q)).map((p) => ({ kind: 'page', id: p.href, label: p.label, href: p.href }));
    return HttpResponse.json({ items: [...docs, ...parties, ...pages] });
  }),
];
