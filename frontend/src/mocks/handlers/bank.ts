import { HttpResponse, http } from 'msw';
import type { Actor, BankLine, Page } from '@/domain/types';
import { discardAttachment } from '../engine/attachments';
import { importStatement, type StatementInput } from '../engine/bank-import';
import { MockError } from '../engine/log';
import { bankGlAccounts, glClaim } from '../records/bank-accounts';
import { ctx, forbidden, persist, problem, screenGate } from './common';

const ACTOR: Actor = { kind: 'user', id: 'u-1', name: 'สมศรี บัญชีดี' };
type Ctx = ReturnType<typeof ctx>;
const STATUSES = ['unmatched', 'matched', 'ignored', 'posted'];

/** Screen-state gate, one permission check; MockError becomes problem+json. */
async function guarded(gate: 'list' | 'item', perm: string, run: (c: Ctx) => Response | Promise<Response>): Promise<Response> {
  const g = await screenGate(gate);
  if (g) return g;
  try {
    const c = ctx();
    if (!c.perms.includes(perm)) return forbidden(perm);
    return await run(c);
  } catch (e) {
    if (e instanceof MockError) return problem(e.status, e.code, e.title);
    throw e;
  }
}
const accountOf = (c: Ctx, id: unknown) => {
  const b = c.st.bankAccounts.find((x) => x.id === id && x.companyId === c.company.id);
  if (!b) throw new MockError(404, 'record.not_found', 'ไม่พบข้อมูลนี้');
  return b;
};

export const bankHandlers = [
  // the postable current-asset accounts a bank / cash account can be bound to; `taken` = another bank account owns it (one GL account each, §5.13) or a posting rule / journal line already uses it for something else (M1)
  http.get('*/bff/v1/finance/bank-gl-accounts', () => guarded('item', 'bank.read', (c) => HttpResponse.json(
    bankGlAccounts(c.st, c.company.id).map((a) => ({ code: a.code, nameTh: a.nameTh, subClass: a.subClass, taken: c.st.bankAccounts.some((b) => b.companyId === c.company.id && b.accountCode === a.code) || glClaim(c.st, c.company.id, a.code) !== undefined }))))),

  http.post('*/bff/v1/finance/bank-accounts/:id/imports', ({ request, params }) => guarded('item', 'bank.manage', async (c) => {
    const acct = accountOf(c, params.id);
    const body = (await request.json().catch(() => undefined)) as StatementInput | undefined;
    if (!body || typeof body !== 'object') throw new MockError(422, 'bank.invalid_request', 'ข้อมูลการนำเข้าไม่ถูกต้อง');
    const imp = importStatement(c.st, c.company.id, acct.id, body, ACTOR);
    try { persist(c.st); } catch (e) { discardAttachment(c.st, `att-${imp.id}`); throw e; } // one state write; a refused one leaves the file bytes gone too
    return HttpResponse.json(imp, { status: 201 });
  })),

  http.get('*/bff/v1/finance/bank-accounts/:id/lines', ({ request, params }) => guarded('list', 'bank.read', (c) => {
    const acct = accountOf(c, params.id);
    const u = new URL(request.url);
    const status = u.searchParams.get('status') || undefined, from = u.searchParams.get('from') || undefined, to = u.searchParams.get('to') || undefined;
    if (status && !STATUSES.includes(status)) throw new MockError(422, 'bank.invalid_filter', 'สถานะที่เลือกไม่ถูกต้อง');
    const limit = Math.min(Number(u.searchParams.get('limit')) || 50, 200);
    const offset = u.searchParams.get('cursor') ? Number(atob(u.searchParams.get('cursor')!)) || 0 : 0;
    const rows = c.st.bankLines.filter((l) => l.companyId === c.company.id && l.accountId === acct.id && (!status || l.status === status) && (!from || l.date >= from) && (!to || l.date <= to))
      .sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id)) // newest first
      .map(({ companyId, ...l }): BankLine => { void companyId; return l; });
    const next = offset + limit;
    return HttpResponse.json({ items: rows.slice(offset, next), total: rows.length, ...(next < rows.length ? { nextCursor: btoa(String(next)) } : {}) } satisfies Page<BankLine>);
  })),
];
