import { HttpResponse, http } from 'msw';
import type { Actor } from '@/domain/types';
import { getReport } from '../engine/agent-review';
import { FieldErrors, refuseAgent } from '../engine/company';
import { MockError } from '../engine/log';
import { AGENT, USER } from '../fixtures/documents';
import { consentInfo, createKey, decideConsent, listApps, listKeys, policyView, revokeApp, revokeKey, rotateKey, scopeChoices, setPolicy } from '../records/connect';
import { ctx, forbidden, persist, problem, screenGate } from './common';
import { ACTOR_HEADER } from './settings';

/** HC2: TEAS Connect. Every `/connect/*` and `/oauth/*` call needs `connect.manage` (admin); a write refuses an agent BEFORE its body is read (§8.5); the report view needs the read right of the document's type. */
const actorOf = (req: Request): Actor => {
  const a = req.headers.get(ACTOR_HEADER) === 'agent' ? AGENT : USER;
  if (req.method !== 'GET') refuseAgent(a);
  return a;
};
const bodyOf = async (req: Request): Promise<Record<string, unknown>> => {
  const b: unknown = await req.json().catch(() => undefined);
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new MockError(422, 'record.invalid', 'ข้อมูลไม่ถูกต้อง');
  return b as Record<string, unknown>;
};
type C = ReturnType<typeof ctx>;
const owner = (c: C) => ({ id: USER.id, name: USER.name, perms: c.perms });

async function guarded(kind: 'list' | 'item', perm: string | ((c: C) => string), run: (c: C) => Response | Promise<Response>) {
  const gate = await screenGate(kind);
  if (gate) return gate;
  try {
    const c = ctx(), need = typeof perm === 'string' ? perm : perm(c);
    if (!c.perms.includes(need)) return forbidden(need);
    return await run(c);
  } catch (e) {
    if (e instanceof FieldErrors) return problem(e.status, e.code, e.title, { fieldErrors: e.fieldErrors });
    if (e instanceof MockError) return problem(e.status, e.code, e.title);
    throw e;
  }
}
const write = (c: C, value: object, status = 200) => { persist(c.st); return HttpResponse.json(value, { status }); };
const M = 'connect.manage';

export const connectHandlers = [
  http.get('*/bff/v1/connect/keys', () => guarded('list', M, (c) => HttpResponse.json({ items: listKeys(c.st, c.company.id), scopeChoices: scopeChoices(c.perms) }))),
  http.post('*/bff/v1/connect/keys', ({ request }) => guarded('item', M, async (c) => { const a = actorOf(request); return write(c, createKey(c.st, a, c.company.id, owner(c), await bodyOf(request)), 201); })),
  http.post('*/bff/v1/connect/keys/:id/rotate', ({ request, params }) => guarded('item', M, async (c) => { const a = actorOf(request); return write(c, rotateKey(c.st, a, c.company.id, String(params.id), (await bodyOf(request)).version), 201); })),
  http.post('*/bff/v1/connect/keys/:id/revoke', ({ request, params }) => guarded('item', M, async (c) => { const a = actorOf(request); return write(c, revokeKey(c.st, a, c.company.id, String(params.id), (await bodyOf(request)).version)); })),

  http.get('*/bff/v1/connect/apps', () => guarded('list', M, (c) => HttpResponse.json({ items: listApps(c.st, c.company.id) }))),
  http.post('*/bff/v1/connect/apps/:id/revoke', ({ request, params }) => guarded('item', M, async (c) => { const a = actorOf(request); return write(c, revokeApp(c.st, a, c.company.id, String(params.id), (await bodyOf(request)).version)); })),

  http.get('*/bff/v1/connect/policy', () => guarded('list', M, (c) => HttpResponse.json(policyView(c.st, c.company.id)))),
  http.put('*/bff/v1/connect/policy/:type', ({ request, params }) => guarded('item', M, async (c) => { const a = actorOf(request); return write(c, setPolicy(c.st, a, c.company.id, String(params.type), await bodyOf(request))); })),

  http.get('*/bff/v1/oauth/consent-info', ({ request }) => guarded('item', M, (c) => HttpResponse.json(consentInfo(c.st, c.company.id, owner(c), new URL(request.url).searchParams.get('client') ?? '')))),
  http.post('*/bff/v1/oauth/consent', ({ request }) => guarded('item', M, async (c) => {
    const a = actorOf(request), b = await bodyOf(request);
    return write(c, decideConsent(c.st, a, c.company.id, owner(c), String(b.client), b.decision));
  })),

  // the stored report, as made: the right to read the document's type decides (another company's report is a 404)
  http.get('*/bff/v1/agent-reports/:id', async ({ params }) => {
    const gate = await screenGate('item');
    if (gate) return gate;
    try {
      const c = ctx(), r = getReport(c.st, c.company.id, String(params.id));
      if (!c.perms.includes(`doc.${r.docType}.read`)) return forbidden(`doc.${r.docType}.read`);
      return HttpResponse.json(r);
    } catch (e) {
      if (e instanceof MockError) return problem(e.status, e.code, e.title);
      throw e;
    }
  }),
];
