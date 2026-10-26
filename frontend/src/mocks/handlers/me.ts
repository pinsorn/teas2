import { HttpResponse, http } from 'msw';
import type { Me } from '@/domain/types';
import { setSettings } from '../settings';
import { today } from '../engine/log';
import type { Actor } from '@/domain/types';
import { AGENT, USER } from '../fixtures/documents';
import { ctx, problem, screenGate } from './common';

/** An agent's calls reach the mock with this header (over MCP in the real system); everything from the web app is the signed-in user. */
export const ACTOR_HEADER = 'x-teas-actor';
export const actorFor = (req: Request): Actor => (req.headers.get(ACTOR_HEADER) === 'agent' ? AGENT : USER);

/** HC2b (§8.5), ONE choke point: an agent request is refused unless its method + route is here. Everything else that writes (settlements, bank, payroll, assets, schedules, periods, filings, settings, keys ...) is refused BEFORE any handler runs; the engine refusals stay as defence in depth.
 *  Allowed: create / compute a draft, update / delete a draft (the engine limits it to the agent's OWN draft), review it, issue it (through the review gate), and read-only GETs (not the key and consent surface). */
export const AGENT_ALLOWED: { method: string; path: RegExp }[] = [
  { method: 'POST', path: /^\/docs\/[A-Za-z]+(\/compute)?$/ },
  { method: 'PUT', path: /^\/docs\/[A-Za-z]+\/[^/]+$/ },
  { method: 'DELETE', path: /^\/docs\/[A-Za-z]+\/[^/]+$/ },
  { method: 'POST', path: /^\/docs\/[A-Za-z]+\/[^/]+\/(issue|agent-review)$/ },
  { method: 'GET', path: /^\/(?!connect\/|oauth\/)/ },
];
export const agentGate = http.all('*/bff/v1/*', ({ request }) => {
  if (request.headers.get(ACTOR_HEADER) !== 'agent') return undefined;
  const path = new URL(request.url).pathname.replace(/^.*\/bff\/v1/, '');
  if (AGENT_ALLOWED.some((a) => a.method === request.method && a.path.test(path))) return undefined;
  if (path.startsWith('/settings/')) return problem(403, 'agent.forbidden_setting', 'ตัวแทน (agent) เปลี่ยนการตั้งค่าไม่ได้ ต้องให้ผู้ใช้ทำเอง'); // §8.5: a settings write keeps its own code
  return problem(403, 'agent.forbidden_action', 'ตัวแทน (agent) ทำรายการนี้ไม่ได้ ต้องให้ผู้ใช้ทำเอง');
});

export const buildMe = (): Me => {
  const { st, s, company, perms } = ctx();
  return {
    userId: 'u-1', displayName: 'สมศรี บัญชีดี', activeCompanyId: company.id, vatRegistered: company.vatRegistered, permissions: perms, businessDate: today(),
    memberships: st.memberships.map((m) => ({ companyId: m.companyId, companyName: m.companyName, role: m.companyId === company.id ? s.role : m.role })),
  };
};

export const meHandlers = [
  agentGate,
  http.get('*/bff/v1/me', async () => (await screenGate('me')) ?? HttpResponse.json(buildMe())),
  http.post('*/bff/v1/me/active-company', async ({ request }) => {
    const { companyId } = (await request.json()) as { companyId?: string };
    if (companyId !== 'co-vat' && companyId !== 'co-nonvat') return problem(404, 'company.not_found', 'ไม่พบบริษัท');
    setSettings({ companyKey: companyId === 'co-vat' ? 'vat' : 'nonvat' });
    return HttpResponse.json(buildMe());
  }),
];
