import { HttpResponse, http } from 'msw';
import type { Actor } from '@/domain/types';
import { FieldErrors, companySettings, updateCompany, type CompanySection } from '../engine/company';
import { MockError } from '../engine/log';
import { AGENT, USER } from '../fixtures/documents';
import { createRole, deleteRole, listRoles, updateRole } from '../records/roles';
import { inviteUser, listUsers, resetLink, setUserActive, updateUser } from '../records/users';
import { ctx, forbidden, persist, problem, screenGate } from './common';

/** An agent's calls reach the mock with this header (over MCP in the real system); everything from the web app is the signed-in user. */
export const ACTOR_HEADER = 'x-teas-actor';
const actorOf = (req: Request): Actor => (req.headers.get(ACTOR_HEADER) === 'agent' ? AGENT : USER);
const bodyOf = async (req: Request): Promise<Record<string, unknown>> => {
  const b: unknown = await req.json().catch(() => undefined);
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new MockError(422, 'record.invalid', 'ข้อมูลไม่ถูกต้อง');
  return b as Record<string, unknown>;
};

/** Gate order: screen state, permission, then the command; a MockError becomes problem+json (a FieldErrors carries `fieldErrors`). A write is persisted only when it succeeded. */
async function guarded(kind: 'list' | 'item', perm: 'settings.manage' | 'users.manage', run: (c: ReturnType<typeof ctx>) => Response | Promise<Response>) {
  const gate = await screenGate(kind);
  if (gate) return gate;
  try {
    const c = ctx();
    if (!c.perms.includes(perm)) return forbidden(perm);
    return await run(c);
  } catch (e) {
    if (e instanceof FieldErrors) return problem(e.status, e.code, e.title, { fieldErrors: e.fieldErrors });
    if (e instanceof MockError) return problem(e.status, e.code, e.title);
    throw e;
  }
}
const write = (c: ReturnType<typeof ctx>, value: object, status = 200) => { persist(c.st); return HttpResponse.json(value, { status }); };
const own = (c: ReturnType<typeof ctx>, id: unknown) => { if (id !== c.company.id) throw new MockError(404, 'company.not_found', 'ไม่พบบริษัท'); };

export const settingsHandlers = [
  // ---- company (settings.manage) ----
  http.get('*/bff/v1/settings/companies/:id', ({ params }) => guarded('item', 'settings.manage', (c) => { own(c, params.id); return HttpResponse.json(companySettings(c.st, c.company.id)); })),
  http.put('*/bff/v1/settings/companies/:id/:section', ({ request, params }) => guarded('item', 'settings.manage', async (c) => {
    own(c, params.id);
    return write(c, updateCompany(c.st, actorOf(request), c.company.id, params.section as CompanySection, await bodyOf(request)));
  })),

  // ---- users (users.manage) ----
  http.get('*/bff/v1/settings/users', () => guarded('list', 'users.manage', (c) => HttpResponse.json({ items: listUsers(c.st, c.company.id) }))),
  http.post('*/bff/v1/settings/users', ({ request }) => guarded('item', 'users.manage', async (c) => {
    const { row, link } = inviteUser(c.st, actorOf(request), c.company.id, await bodyOf(request));
    return write(c, { ...row, link }, 201); // the only response that carries the link
  })),
  http.put('*/bff/v1/settings/users/:id', ({ request, params }) => guarded('item', 'users.manage', async (c) => write(c, updateUser(c.st, actorOf(request), c.company.id, String(params.id), await bodyOf(request))))),
  http.post('*/bff/v1/settings/users/:id/active', ({ request, params }) => guarded('item', 'users.manage', async (c) => {
    const b = await bodyOf(request);
    if (typeof b.active !== 'boolean') throw new MockError(422, 'record.invalid', 'ต้องระบุสถานะใช้งาน');
    return write(c, setUserActive(c.st, actorOf(request), c.company.id, String(params.id), b.active, b.version));
  })),
  http.post('*/bff/v1/settings/users/:id/reset-link', ({ request, params }) => guarded('item', 'users.manage', (c) => write(c, { link: resetLink(c.st, actorOf(request), c.company.id, String(params.id)) }))),

  // ---- roles (users.manage) ----
  http.get('*/bff/v1/settings/roles', () => guarded('list', 'users.manage', (c) => HttpResponse.json({ items: listRoles(c.st, c.company.id) }))),
  http.post('*/bff/v1/settings/roles', ({ request }) => guarded('item', 'users.manage', async (c) => write(c, createRole(c.st, actorOf(request), c.company.id, await bodyOf(request)), 201))),
  http.put('*/bff/v1/settings/roles/:id', ({ request, params }) => guarded('item', 'users.manage', async (c) => write(c, updateRole(c.st, actorOf(request), c.company.id, String(params.id), await bodyOf(request))))),
  http.delete('*/bff/v1/settings/roles/:id', ({ request, params }) => guarded('item', 'users.manage', (c) => { deleteRole(c.st, actorOf(request), c.company.id, String(params.id)); return write(c, { ok: true }); })),
];
