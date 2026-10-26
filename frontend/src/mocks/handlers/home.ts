import { HttpResponse, http } from 'msw';
import { HOME_NEEDS } from '@/domain/home';
import type { HomeSection } from '@/domain/types';
import { homeAgent, homeAlerts, homeApprovals, homeBank, homeDeadlines, homeDrafts, homeKpis, homeOverdue } from '../engine/home';
import { USER } from '../fixtures/documents';
import { ctx, forbidden, problem, screenGate } from './common';

/** HC1: one endpoint per Home section (each has its own right and its own loading / error state); the figures come from the engines, never from a re-sum here. */
export const homeHandlers = [
  http.get('*/bff/v1/home/:section', async ({ params }) => {
    const section = String(params.section) as HomeSection;
    if (!Object.hasOwn(HOME_NEEDS, section)) return problem(404, 'home.unknown_section', 'ไม่รู้จักส่วนนี้ของหน้าหลัก');
    const gate = await screenGate('item');
    if (gate) return gate;
    const { st, s, company, perms } = ctx();
    if (!HOME_NEEDS[section](perms)) return forbidden(`home.${section}`);
    const empty = s.screenState === 'empty', c = company.id;
    if (section === 'kpis') { // the same per-tile gating whatever the screen state; no tile visible = the section is forbidden
      const k = homeKpis(st, c, perms);
      if (Object.values(k).every((v) => v === null)) return forbidden('home.kpis');
      return HttpResponse.json(empty ? Object.fromEntries(Object.entries(k).map(([key, v]) => [key, v === null ? null : '0.00'])) : k);
    }
    switch (section) {
      case 'approvals': return HttpResponse.json(empty ? [] : homeApprovals(st, c, perms, USER));
      case 'drafts': return HttpResponse.json(empty ? [] : homeDrafts(st, c, perms, USER));
      case 'overdue': return HttpResponse.json(empty ? [] : homeOverdue(st, c, perms));
      case 'deadlines': return HttpResponse.json(empty ? [] : homeDeadlines(st, c));
      case 'bank': return HttpResponse.json(empty ? 0 : homeBank(st, c));
      case 'agent': return HttpResponse.json(empty ? { posted: 0, waiting: 0 } : homeAgent(st, c, perms));
      case 'alerts': return HttpResponse.json(empty ? [] : homeAlerts(st, c, perms));
    }
  }),
];
