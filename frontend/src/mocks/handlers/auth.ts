import { HttpResponse, http } from 'msw';
import type { Actor, DocType } from '@/domain/types';
import { PAPER_BUILDERS } from '../engine/paper';
import { FieldErrors } from '../engine/company';
import { activeLinkCount, changePassword, confirmEnrol, createPublicLink, currentUserId, DEMO, listSessions, login, logout, onboard, profileOf, relogin, resolvePublicLink, revokePublicLinks, revokeSession, startEnrol, verifyTotp } from '../engine/auth';
import { publicDoc } from '../engine/commands';
import { MockError } from '../engine/log';
import { AGENT, USER } from '../fixtures/documents';
import { getSession, setSession, setSettings } from '../settings';
import { ctx, forbidden, persist, problem } from './common';
import { ACTOR_HEADER } from './settings';

// SP1c HC3 (D-32: mock-only auth). EVERY route here refuses an agent (header x-teas-actor: agent) - the writes are already outside AGENT_ALLOWED, and the reads (which the GET rule would let through) say no here.
// The engine hands back failures AFTER counting them (the lockout), so a failed call still saves the state.
const isAgent = (req: Request) => req.headers.get(ACTOR_HEADER) === 'agent';
const actorOf = (req: Request): Actor => (isAgent(req) ? AGENT : USER);
const noAgent = () => problem(403, 'agent.forbidden_action', 'ตัวแทน (agent) ทำรายการนี้ไม่ได้ ต้องให้ผู้ใช้ทำเอง');
const bodyOf = async (req: Request): Promise<Record<string, unknown>> => {
  const b: unknown = await req.json().catch(() => undefined);
  return b && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
};
const s = (v: unknown): string => (typeof v === 'string' ? v : '');

type C = ReturnType<typeof ctx>;
/** `write`: the state is saved on success AND on a refusal (the failure counters live in it). */
async function run(req: Request, write: boolean, fn: (c: C, actor: Actor) => Response | Promise<Response>) {
  if (isAgent(req)) return noAgent();
  const c = ctx();
  try {
    const r = await fn(c, actorOf(req));
    if (write) persist(c.st);
    return r;
  } catch (e) {
    if (e instanceof FieldErrors) return problem(e.status, e.code, e.title, { fieldErrors: e.fieldErrors });
    if (e instanceof MockError) { if (write && e.status !== 507) persist(c.st); return problem(e.status, e.code, e.title); }
    throw e;
  }
}

/** The toolbar's session state decides what the signed-in app may do: expired / signed out = 401 on everything but the sign-in routes and the public link. An agent has no browser session. */
const OPEN = /^\/(auth\/(login|totp|session|logout|relogin|demo)|public\/)/;
export const sessionGate = http.all('*/bff/v1/*', ({ request }) => {
  if (isAgent(request)) return undefined;
  const path = new URL(request.url).pathname.replace(/^.*\/bff\/v1/, '');
  if (OPEN.test(path)) return undefined;
  const session = getSession();
  if (session === 'expired') return problem(401, 'auth.session_expired', 'เซสชันหมดอายุ กรอกรหัสผ่านเพื่อดำเนินการต่อ');
  if (session === 'out') return problem(401, 'auth.unauthenticated', 'ยังไม่ได้เข้าสู่ระบบ');
  return undefined;
});

const ok = (st: C['st']) => ({ status: 'ok' as const, userId: currentUserId(st) });

export const authHandlers = [
  http.post('*/bff/v1/auth/login', ({ request }) => run(request, true, async (c) => {
    const b = await bodyOf(request);
    const r = login(c.st, s(b.email), s(b.password));
    if (r.status === 'ok') setSession('active');
    return HttpResponse.json(r.status === 'ok' ? ok(c.st) : r);
  })),
  http.post('*/bff/v1/auth/totp', ({ request }) => run(request, true, async (c) => {
    const b = await bodyOf(request);
    verifyTotp(c.st, s(b.challenge), typeof b.recoveryCode === 'string' ? { recoveryCode: b.recoveryCode } : { code: s(b.code) });
    setSession('active');
    return HttpResponse.json(ok(c.st));
  })),
  http.get('*/bff/v1/auth/session', ({ request }) => run(request, false, (c) => {
    const session = getSession();
    return HttpResponse.json({ state: session, email: profileOf(c.st, currentUserId(c.st)).email, ...(session === 'expiring' ? { expiresInSec: 120 } : {}) });
  })),
  http.post('*/bff/v1/auth/session/extend', ({ request }) => run(request, false, () => { setSession('active'); return HttpResponse.json({ state: 'active' }); })),
  http.post('*/bff/v1/auth/logout', ({ request }) => run(request, true, (c) => { logout(c.st); setSession('out'); return HttpResponse.json({ state: 'out' }); })),
  http.post('*/bff/v1/auth/relogin', ({ request }) => run(request, true, async (c) => {
    relogin(c.st, currentUserId(c.st), s((await bodyOf(request)).password));
    setSession('active');
    return HttpResponse.json({ state: 'active' });
  })),
  // the mock's demo identities, so a person reviewing the mockup knows what to type; a real backend has no such route
  http.get('*/bff/v1/auth/demo', ({ request }) => run(request, false, () => HttpResponse.json({ email: DEMO.email, password: DEMO.password, totpEmail: DEMO.totpEmail, totpPassword: DEMO.totpPassword, totpCode: DEMO.totpCode, recoveryCode: DEMO.recovery[3] }))),

  http.get('*/bff/v1/auth/profile', ({ request }) => run(request, false, (c) => HttpResponse.json(profileOf(c.st, currentUserId(c.st))))),
  http.post('*/bff/v1/auth/password', ({ request }) => run(request, true, async (c, a) => {
    const b = await bodyOf(request);
    changePassword(c.st, a, currentUserId(c.st), { current: s(b.current), next: s(b.next), confirm: s(b.confirm) });
    return HttpResponse.json({ status: 'ok' });
  })),
  http.post('*/bff/v1/auth/totp/enrol', ({ request }) => run(request, true, (c, a) => HttpResponse.json(startEnrol(c.st, a, currentUserId(c.st))))),
  http.post('*/bff/v1/auth/totp/enrol/verify', ({ request }) => run(request, true, async (c, a) => HttpResponse.json(confirmEnrol(c.st, a, currentUserId(c.st), s((await bodyOf(request)).code))))),
  http.get('*/bff/v1/auth/sessions', ({ request }) => run(request, false, (c) => HttpResponse.json({ items: listSessions(c.st, currentUserId(c.st)) }))),
  http.post('*/bff/v1/auth/sessions/:id/revoke', ({ request, params }) => run(request, true, (c, a) => {
    const r = revokeSession(c.st, a, currentUserId(c.st), String(params.id));
    if (r.signedOut) setSession('out');
    return HttpResponse.json(r);
  })),

  http.post('*/bff/v1/onboarding', ({ request }) => run(request, true, async (c, a) => {
    const r = onboard(c.st, a, await bodyOf(request));
    setSettings({ companyKey: 'new' });
    return HttpResponse.json(r, { status: 201 });
  })),

  // a public link belongs to one issued document of the ACTIVE company; the right is the document's read right
  http.get('*/bff/v1/docs/:type/:id/public-links', ({ request, params }) => run(request, false, (c) => {
    const perm = `doc.${String(params.type)}.read`;
    if (!c.perms.includes(perm)) return forbidden(perm);
    return HttpResponse.json({ active: activeLinkCount(c.st, c.company.id, String(params.id)) });
  })),
  http.post('*/bff/v1/docs/:type/:id/public-links', ({ request, params }) => run(request, true, (c, a) => {
    const perm = `doc.${String(params.type)}.read`;
    if (!c.perms.includes(perm)) return forbidden(perm);
    const d = c.st.docs.find((x) => x.id === params.id && x.companyId === c.company.id && x.type === params.type);
    if (!d) throw new MockError(404, 'doc.not_found', 'ไม่พบเอกสาร');
    return HttpResponse.json(createPublicLink(c.st, a, c.company.id, d.id), { status: 201 });
  })),
  http.delete('*/bff/v1/docs/:type/:id/public-links', ({ request, params }) => run(request, true, (c, a) => {
    const perm = `doc.${String(params.type)}.read`;
    if (!c.perms.includes(perm)) return forbidden(perm);
    return HttpResponse.json({ revoked: revokePublicLinks(c.st, a, c.company.id, String(params.id)) });
  })),

  // /p/<token>: sessionless. Unknown, revoked, or the document no longer issued = ONE answer. The paper is built by the same PAPER_BUILDERS as every print, for the document's own company; it is the electronic copy (สำเนา).
  http.get('*/bff/v1/public/p/:token', ({ params }) => {
    const gone = () => problem(404, 'public.link_invalid', 'ลิงก์นี้ใช้ไม่ได้แล้ว');
    try {
      const c = ctx(), hit = resolvePublicLink(c.st, String(params.token));
      const builder = hit && PAPER_BUILDERS[hit.doc.type as DocType];
      const company = hit && c.st.companies.find((x) => x.id === hit.link.companyId);
      if (!hit || !builder || !company) return gone();
      return HttpResponse.json({ type: hit.doc.type, paper: builder({ ...c, company, perms: [] }, publicDoc(hit.doc), true) });
    } catch { return gone(); }
  }),
];
