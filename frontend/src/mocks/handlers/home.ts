import { HttpResponse, http } from 'msw';
import type { HomeInbox } from '@/domain/types';
import { fromSatang, toSatang } from '../engine/money';
import { ANCHOR } from '../fixtures/documents';
import { toSummary } from './docs-read';
import { ctx, screenGate } from './common';

export const homeHandlers = [
  http.get('*/bff/v1/home', async () => {
    const gate = await screenGate('item');
    if (gate) return gate;
    const { st, s, company, perms } = ctx();
    const docs = s.screenState === 'empty' ? [] : st.docs.filter((d) => d.companyId === company.id && perms.includes(`doc.${d.type}.read`));
    const open = docs.filter((d) => d.status === 'issued' || d.status === 'partly_settled');
    const agent = docs.filter((d) => d.createdBy.kind === 'agent');
    const month = ANCHOR.slice(0, 7);
    const sum = (xs: string[]) => fromSatang(xs.reduce((a, x) => a + toSatang(x), 0));
    const body: HomeInbox = {
      approvals: docs.filter((d) => d.status === 'pending').map(toSummary),
      myDrafts: docs.filter((d) => d.status === 'draft').map(toSummary),
      overdue: open.filter((d) => d.header.dueDate && d.header.dueDate < ANCHOR).map(toSummary),
      deadlines: company.vatRegistered
        ? [{ form: 'ภ.พ.30', due: '2026-10-15' }, { form: 'ภ.ง.ด.53', due: '2026-10-07' }]
        : [{ form: 'ภ.ง.ด.53', due: '2026-10-07' }],
      unreconciledLines: docs.length ? 7 : 0,
      agentDigest: { posted: agent.filter((d) => d.status !== 'draft').length, waiting: agent.filter((d) => d.status === 'draft').length },
      kpis: {
        cash: docs.length ? '482350.00' : '0.00',
        ar: sum(open.filter((d) => d.type === 'TI').map((d) => d.outstanding ?? '0.00')),
        ap: docs.length ? '126400.00' : '0.00',
        vatThisMonth: company.vatRegistered
          ? sum(docs.filter((d) => d.type === 'TI' && d.number && d.header.documentDate.startsWith(month) && d.status !== 'replaced').map((d) => d.totals.vat))
          : null,
      },
    };
    return HttpResponse.json(body);
  }),
];
