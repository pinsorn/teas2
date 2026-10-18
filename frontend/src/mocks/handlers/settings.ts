import { HttpResponse, http } from 'msw';
import type { Actor } from '@/domain/types';
import { FieldErrors, companySettings, refuseAgent, updateCompany, type CompanySection } from '../engine/company';
import { MockError } from '../engine/log';
import { AGENT, USER } from '../fixtures/documents';
import { createRole, deleteRole, listRoles, updateRole } from '../records/roles';
import { createDimensionType, createDimensionValue, deleteDimensionType, deleteDimensionValue, dimensionsView, listAccountRules, setAccountRules, updateDimensionType, updateDimensionValue } from '../records/dimensions';
import { assetClassesOf, createCategory, deleteCategory, listCategories, updateCategory } from '../records/expense-categories';
import { createPostingRule, deletePostingRule, listPostingRules, previewPosting, updatePostingRule } from '../records/posting-rules';
import { acceptInvite, inviteUser, listUsers, resetLink, setUserActive, updateUser } from '../records/users';
import { ctx, forbidden, persist, problem, screenGate } from './common';

/** An agent's calls reach the mock with this header (over MCP in the real system); everything from the web app is the signed-in user. */
export const ACTOR_HEADER = 'x-teas-actor';
/** ST1a m7: a write refuses an agent BEFORE its body is read or validated (403, never a 422 that leaks the shape). */
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

/** Gate order: screen state, permission, then the command; a MockError becomes problem+json (a FieldErrors carries `fieldErrors`). A write is persisted only when it succeeded. */
async function guarded(kind: 'list' | 'item', perm: 'settings.manage' | 'users.manage' | 'ledger.posting.manage' | null, run: (c: ReturnType<typeof ctx>) => Response | Promise<Response>) {
  const gate = await screenGate(kind);
  if (gate) return gate;
  try {
    const c = ctx();
    if (perm && !c.perms.includes(perm)) return forbidden(perm); // null = any signed-in user (the editor reads the dimensions and categories)
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
    const actor = actorOf(request), body = await bodyOf(request);
    if (typeof body.version !== 'number') throw new MockError(422, 'record.invalid', 'ต้องระบุเวอร์ชันของข้อมูลบริษัทที่แก้ไข');
    return write(c, updateCompany(c.st, actor, c.company.id, params.section as CompanySection, body));
  })),

  // ---- users (users.manage) ----
  http.get('*/bff/v1/settings/users', () => guarded('list', 'users.manage', (c) => HttpResponse.json({ items: listUsers(c.st, c.company.id, c.s.role) }))),
  http.post('*/bff/v1/settings/users', ({ request }) => guarded('item', 'users.manage', async (c) => {
    const { row, link } = inviteUser(c.st, actorOf(request), c.company.id, await bodyOf(request));
    return write(c, { ...row, link }, 201); // the only response that carries the link
  })),
  http.put('*/bff/v1/settings/users/:id', ({ request, params }) => guarded('item', 'users.manage', async (c) => write(c, updateUser(c.st, actorOf(request), c.company.id, String(params.id), await bodyOf(request), c.s.role)))),
  http.post('*/bff/v1/settings/users/:id/active', ({ request, params }) => guarded('item', 'users.manage', async (c) => {
    const actor = actorOf(request);
    const b = await bodyOf(request);
    if (typeof b.active !== 'boolean') throw new MockError(422, 'record.invalid', 'ต้องระบุสถานะใช้งาน');
    return write(c, setUserActive(c.st, actor, c.company.id, String(params.id), b.active, b.version, c.s.role));
  })),
  http.post('*/bff/v1/settings/users/:id/accept', ({ request, params }) => guarded('item', 'users.manage', (c) => write(c, acceptInvite(c.st, actorOf(request), c.company.id, String(params.id))))), // ST1a M1: the mock's "invite accepted"
  http.post('*/bff/v1/settings/users/:id/reset-link', ({ request, params }) => guarded('item', 'users.manage', (c) => write(c, { link: resetLink(c.st, actorOf(request), c.company.id, String(params.id)) }))),

  // ---- roles (users.manage) ----
  http.get('*/bff/v1/settings/roles', () => guarded('list', 'users.manage', (c) => HttpResponse.json({ items: listRoles(c.st, c.company.id) }))),
  http.post('*/bff/v1/settings/roles', ({ request }) => guarded('item', 'users.manage', async (c) => write(c, createRole(c.st, actorOf(request), c.company.id, await bodyOf(request)), 201))),
  http.put('*/bff/v1/settings/roles/:id', ({ request, params }) => guarded('item', 'users.manage', async (c) => write(c, updateRole(c.st, actorOf(request), c.company.id, String(params.id), await bodyOf(request))))),
  http.delete('*/bff/v1/settings/roles/:id', ({ request, params }) => guarded('item', 'users.manage', (c) => { deleteRole(c.st, actorOf(request), c.company.id, String(params.id)); return write(c, { ok: true }); })),

  // ---- ST2 posting rules (ledger.posting.manage); the id of a rule is `level|key|role` ----
  http.get('*/bff/v1/settings/posting/rules', () => guarded('list', 'ledger.posting.manage', (c) => HttpResponse.json(listPostingRules(c.st, c.company.id)))),
  http.post('*/bff/v1/settings/posting/rules', ({ request }) => guarded('item', 'ledger.posting.manage', async (c) => { const a = actorOf(request); return write(c, createPostingRule(c.st, a, c.company.id, await bodyOf(request)), 201); })),
  http.put('*/bff/v1/settings/posting/rules/:id', ({ request, params }) => guarded('item', 'ledger.posting.manage', async (c) => { const a = actorOf(request); return write(c, updatePostingRule(c.st, a, c.company.id, decodeURIComponent(String(params.id)), await bodyOf(request))); })),
  http.delete('*/bff/v1/settings/posting/rules/:id', ({ request, params }) => guarded('item', 'ledger.posting.manage', (c) => {
    deletePostingRule(c.st, actorOf(request), c.company.id, decodeURIComponent(String(params.id)), Number(new URL(request.url).searchParams.get('version')));
    return write(c, { ok: true });
  })),
  http.post('*/bff/v1/settings/posting/preview', ({ request }) => guarded('item', 'ledger.posting.manage', async (c) => HttpResponse.json(previewPosting(c.st, c.company.id, (await bodyOf(request)) as never)))), // read-only: nothing is persisted

  // ---- ST2 expense categories (read: any signed-in user, the line grid offers them; write: ledger.posting.manage) ----
  http.get('*/bff/v1/settings/expense-categories', () => guarded('list', null, (c) => HttpResponse.json({ items: listCategories(c.st, c.company.id), assetClasses: assetClassesOf(c.st, c.company.id) }))),
  http.post('*/bff/v1/settings/expense-categories', ({ request }) => guarded('item', 'ledger.posting.manage', async (c) => { const a = actorOf(request); return write(c, createCategory(c.st, a, c.company.id, await bodyOf(request)), 201); })),
  http.put('*/bff/v1/settings/expense-categories/:code', ({ request, params }) => guarded('item', 'ledger.posting.manage', async (c) => { const a = actorOf(request); return write(c, updateCategory(c.st, a, c.company.id, String(params.code), await bodyOf(request))); })),
  http.delete('*/bff/v1/settings/expense-categories/:code', ({ request, params }) => guarded('item', 'ledger.posting.manage', (c) => {
    deleteCategory(c.st, actorOf(request), c.company.id, String(params.code), Number(new URL(request.url).searchParams.get('version')));
    return write(c, { ok: true });
  })),

  // ---- ST2 dimensions (read: any signed-in user, the editor offers them; write and the account rules: settings.manage) ----
  http.get('*/bff/v1/settings/dimensions/account-rules', () => guarded('list', 'settings.manage', (c) => HttpResponse.json({ items: listAccountRules(c.st, c.company.id) }))),
  http.put('*/bff/v1/settings/dimensions/account-rules/:code', ({ request, params }) => guarded('item', 'settings.manage', async (c) => { const a = actorOf(request); return write(c, setAccountRules(c.st, a, c.company.id, String(params.code), await bodyOf(request))); })),
  http.get('*/bff/v1/settings/dimensions', () => guarded('list', null, (c) => HttpResponse.json(dimensionsView(c.st, c.company.id)))),
  http.post('*/bff/v1/settings/dimensions', ({ request }) => guarded('item', 'settings.manage', async (c) => { const a = actorOf(request); return write(c, createDimensionType(c.st, a, c.company.id, await bodyOf(request)), 201); })),
  http.put('*/bff/v1/settings/dimensions/:key', ({ request, params }) => guarded('item', 'settings.manage', async (c) => { const a = actorOf(request); return write(c, updateDimensionType(c.st, a, c.company.id, String(params.key), await bodyOf(request))); })),
  http.delete('*/bff/v1/settings/dimensions/:key', ({ request, params }) => guarded('item', 'settings.manage', (c) => {
    deleteDimensionType(c.st, actorOf(request), c.company.id, String(params.key), Number(new URL(request.url).searchParams.get('version')));
    return write(c, { ok: true });
  })),
  http.post('*/bff/v1/settings/dimensions/:key/values', ({ request, params }) => guarded('item', 'settings.manage', async (c) => { const a = actorOf(request); return write(c, createDimensionValue(c.st, a, c.company.id, String(params.key), await bodyOf(request)), 201); })),
  http.put('*/bff/v1/settings/dimensions/:key/values/:code', ({ request, params }) => guarded('item', 'settings.manage', async (c) => { const a = actorOf(request); return write(c, updateDimensionValue(c.st, a, c.company.id, String(params.key), String(params.code), await bodyOf(request))); })),
  http.delete('*/bff/v1/settings/dimensions/:key/values/:code', ({ request, params }) => guarded('item', 'settings.manage', (c) => {
    deleteDimensionValue(c.st, actorOf(request), c.company.id, String(params.key), String(params.code), Number(new URL(request.url).searchParams.get('version')));
    return write(c, { ok: true });
  })),
];
