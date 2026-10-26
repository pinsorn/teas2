import { HttpResponse, http } from 'msw';
import type { Actor } from '@/domain/types';
import { getReport, reviewDraft } from '../engine/agent-review';
import { FieldErrors, refuseAgent } from '../engine/company';
import { MockError } from '../engine/log';
import { AGENT, USER } from '../fixtures/documents';
import { consentInfo, createKey, decideConsent, listApps, listKeys, ownerRights, policyView, revokeApp, revokeKey, rotateKey, scopeChoices, setPolicy } from '../records/connect';
import { ctx, forbidden, persist, problem, screenGate } from './common';
import { ACTOR_HEADER } from './settings';

/** HC2 / HC2a: TEAS Connect. Any active member makes, rotates and revokes THEIR OWN keys and approves / denies consent for themselves (their ceiling is their own rights); `connect.manage` (admin) lists and revokes everyone's keys and apps and sets the agent policy.
 *  A write refuses an agent BEFORE its body is read (§8.5); the report view needs the read right of the document's type. */
const actorOf = (req: Request, agentOk = false): Actor => {
  const a = req.headers.get(ACTOR_HEADER) === 'agent' ? AGENT : USER;
  if (req.method !== 'GET' && !agentOk) refuseAgent(a);
  return a;
};
const bodyOf = async (req: Request): Promise<Record<string, unknown>> => {
  const b: unknown = await req.json().catch(() => undefined);
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new MockError(422, 'record.invalid', 'ข้อมูลไม่ถูกต้อง');
  return b as Record<string, unknown>;
};
type C = ReturnType<typeof ctx>;
const owner = { id: USER.id, name: USER.name };
/** Keys: a member sees and handles their own; the manager, everyone's. */
const who = (c: C): string | undefined => (c.perms.includes('connect.manage') ? undefined : USER.id);

async function guarded(kind: 'list' | 'item', perm: string | undefined, run: (c: C) => Response | Promise<Response>) {
  const gate = await screenGate(kind);
  if (gate) return gate;
  try {
    const c = ctx();
    if (perm && !c.perms.includes(perm)) return forbidden(perm);
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
  http.get('*/bff/v1/connect/keys', () => guarded('list', undefined, (c) => HttpResponse.json({ items: listKeys(c.st, c.company.id, who(c)), scopeChoices: scopeChoices(ownerRights(c.st, c.company.id, owner.id)) }))),
  http.post('*/bff/v1/connect/keys', ({ request }) => guarded('item', undefined, async (c) => { const a = actorOf(request); return write(c, createKey(c.st, a, c.company.id, owner, await bodyOf(request)), 201); })),
  http.post('*/bff/v1/connect/keys/:id/rotate', ({ request, params }) => guarded('item', undefined, async (c) => { const a = actorOf(request); return write(c, rotateKey(c.st, a, c.company.id, String(params.id), (await bodyOf(request)).version), 201); })),
  http.post('*/bff/v1/connect/keys/:id/revoke', ({ request, params }) => guarded('item', undefined, async (c) => { const a = actorOf(request); return write(c, revokeKey(c.st, a, c.company.id, String(params.id), (await bodyOf(request)).version, who(c))); })),

  http.get('*/bff/v1/connect/apps', () => guarded('list', undefined, (c) => HttpResponse.json({ items: listApps(c.st, c.company.id, who(c)) }))),
  http.post('*/bff/v1/connect/apps/:id/revoke', ({ request, params }) => guarded('item', undefined, async (c) => { const a = actorOf(request); return write(c, revokeApp(c.st, a, c.company.id, String(params.id), (await bodyOf(request)).version, who(c))); })),

  http.get('*/bff/v1/connect/policy', () => guarded('list', M, (c) => HttpResponse.json(policyView(c.st, c.company.id)))),
  http.put('*/bff/v1/connect/policy/:type', ({ request, params }) => guarded('item', M, async (c) => { const a = actorOf(request); return write(c, setPolicy(c.st, a, c.company.id, String(params.type), await bodyOf(request))); })),

  http.get('*/bff/v1/oauth/consent-info', ({ request }) => guarded('item', undefined, (c) => HttpResponse.json(consentInfo(c.st, c.company.id, owner, new URL(request.url).searchParams.get('client') ?? '')))),
  http.post('*/bff/v1/oauth/consent', ({ request }) => guarded('item', undefined, async (c) => {
    const a = actorOf(request), b = await bodyOf(request);
    return write(c, decideConsent(c.st, a, c.company.id, owner, String(b.client), b.decision, b.companyId));
  })),

  // the agent's `review(document)` call (§8.2): agents only, its own draft; stores a new report
  http.post('*/bff/v1/docs/:type/:id/agent-review', ({ request, params }) => guarded('item', undefined, (c) => {
    const a = actorOf(request, true);
    const d = c.st.docs.find((x) => x.id === params.id && x.type === params.type && x.companyId === c.company.id);
    if (!d) throw new MockError(404, 'doc.not_found', 'ไม่พบเอกสาร');
    if (!c.perms.includes(`doc.${d.type}.create`)) return forbidden(`doc.${d.type}.create`);
    return write(c, getReport(c.st, c.company.id, reviewDraft(c.st, a, d.id).id), 201);
  })),

  // the stored report, as made: the right to read the document's type decides (another company's report is a 404)
  http.get('*/bff/v1/agent-reports/:id', async ({ params }) => {
    const gate = await screenGate('item');
    if (gate) return gate;
    try {
      const c = ctx(), r = getReport(c.st, c.company.id, String(params.id));
      if (!c.perms.includes(`doc.${r.docType}.read`)) return forbidden(`doc.${r.docType}.read`);
      return HttpResponse.json(c.st.docs.some((x) => x.id === r.docId) ? r : { ...r, docNowVersion: 0 }); // n2: 0 = the document no longer exists
    } catch (e) {
      if (e instanceof MockError) return problem(e.status, e.code, e.title);
      throw e;
    }
  }),
];
