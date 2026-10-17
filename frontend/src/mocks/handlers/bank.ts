import { HttpResponse, http } from 'msw';
import type { Actor, BankLine, Page } from '@/domain/types';
import { discardAttachment } from '../engine/attachments';
import { importStatement, type StatementInput } from '../engine/bank-import';
import { MockError } from '../engine/log';
import { type MatchRequest, type PayTaxRequest, type PostRequest, controlExit, ignore, linesOf, lockTo, match, payTax, post, publicLine, reverseTaxPayment, reverseTransfer, suggest, transfer, unignore, unmatch } from '../engine/reconcile';
import { bankGlAccounts, glClaim } from '../records/bank-accounts';
import { ctx, forbidden, persist, problem, screenGate } from './common';

const ACTOR: Actor = { kind: 'user', id: 'u-1', name: 'สมศรี บัญชีดี' };
type Ctx = ReturnType<typeof ctx>;
const STATUSES = ['unmatched', 'matched', 'ignored', 'posted'];
const RECONCILE = 'bank.reconcile';


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
    const only = u.searchParams.get('line') || undefined;
    const status = u.searchParams.get('status') || undefined, from = u.searchParams.get('from') || undefined, to = u.searchParams.get('to') || undefined;
    if (status && !STATUSES.includes(status)) throw new MockError(422, 'bank.invalid_filter', 'สถานะที่เลือกไม่ถูกต้อง');
    const limit = Math.min(Number(u.searchParams.get('limit')) || 50, 200);
    const offset = u.searchParams.get('cursor') ? Number(atob(u.searchParams.get('cursor')!)) || 0 : 0;
    const rows = c.st.bankLines.filter((l) => l.companyId === c.company.id && l.accountId === acct.id && (!only || l.id === only) && (!status || l.status === status) && (!from || l.date >= from) && (!to || l.date <= to))
      .sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id)) // newest first
      .map((l): BankLine => publicLine(c.st, l));
    const next = offset + limit;
    return HttpResponse.json({ items: rows.slice(offset, next), total: rows.length, ...(next < rows.length ? { nextCursor: btoa(String(next)) } : {}) } satisfies Page<BankLine>);
  })),
  // ---- FN2: reconciliation (accountant: bank.reconcile)
  http.get('*/bff/v1/finance/bank-accounts/:id/reconciliation', ({ params }) => guarded('item', 'bank.read', (c) => {
    const acct = accountOf(c, params.id), ls = linesOf(c.st, c.company.id, acct.id);
    return HttpResponse.json({ reconciledTo: acct.reconciledTo ?? null, counts: Object.fromEntries(STATUSES.map((k) => [k, ls.filter((l) => l.status === k).length])) });
  })),
  http.post('*/bff/v1/finance/bank-accounts/:id/reconciled-to', ({ request, params }) => guarded('item', RECONCILE, async (c) => {
    const acct = accountOf(c, params.id);
    const body = (await request.json().catch(() => undefined)) as { date?: string } | undefined;
    lockTo(c.st, c.company.id, acct.id, String(body?.date ?? ''), ACTOR);
    persist(c.st);
    return HttpResponse.json({ reconciledTo: c.st.bankAccounts.find((b) => b.id === acct.id)?.reconciledTo ?? null });
  })),
  // the accounts an inline journal can post to: postable and not a control account (tax, receivable / payable, deposits, payroll, cash / bank, equity); the page drops the bank's own
  http.get('*/bff/v1/finance/postable-accounts', () => guarded('item', RECONCILE, (c) => HttpResponse.json(
    c.st.accounts.filter((a) => a.companyId === c.company.id && a.postable && a.active !== false && !controlExit(c.st, c.company.id, a.code))
      .map((a) => ({ code: a.code, nameTh: a.nameTh, class: a.class }))))),
  // I2: a statement line that is money moving to / from another own account; the way out of the journal
  http.post('*/bff/v1/finance/bank-lines/:id/transfer', ({ request, params }) => guarded('item', RECONCILE, async (c) => {
    const body = ((await request.json().catch(() => undefined)) ?? {}) as { toAccountId?: string };
    const line = transfer(c.st, c.company.id, String(params.id), String(body.toAccountId ?? ''), ACTOR);
    persist(c.st);
    return HttpResponse.json(line);
  })),
  http.post('*/bff/v1/finance/bank-journals/:id/reverse', ({ request, params }) => guarded('item', RECONCILE, async (c) => {
    const body = ((await request.json().catch(() => undefined)) ?? {}) as { reason?: string };
    const isTax = c.st.bankJournals.some((x) => x.id === params.id && x.companyId === c.company.id && x.kind === 'tax'); // TX2c: the same endpoint undoes a tax payment
    const j = (isTax ? reverseTaxPayment : reverseTransfer)(c.st, c.company.id, String(params.id), ACTOR, body.reason);
    persist(c.st);
    return HttpResponse.json({ id: j.id, reversed: true });
  })),
  // TX2c: pay a finalized return from this statement line (Dr the return's payable / Cr the bank)
  http.post('*/bff/v1/finance/bank-lines/:id/pay-tax', ({ request, params }) => guarded('item', RECONCILE, async (c) => {
    const body = ((await request.json().catch(() => undefined)) ?? {}) as unknown as PayTaxRequest;
    const line = payTax(c.st, c.company.id, String(params.id), body, ACTOR);
    persist(c.st);
    return HttpResponse.json(line);
  })),
  http.get('*/bff/v1/finance/bank-lines/:id/candidates', ({ request, params }) => guarded('list', RECONCILE, (c) =>
    HttpResponse.json({ items: suggest(c.st, c.company.id, String(params.id), new URL(request.url).searchParams.get('q') ?? undefined) }))),
  ...(['match', 'unmatch', 'ignore', 'unignore', 'post'] as const).map((cmd) => http.post(`*/bff/v1/finance/bank-lines/:id/${cmd}`, ({ request, params }) => guarded('item', RECONCILE, async (c) => {
    const body = ((await request.json().catch(() => undefined)) ?? {}) as Record<string, unknown>;
    const id = String(params.id), co = c.company.id, reason = typeof body.reason === 'string' ? body.reason : undefined;
    const line = cmd === 'match' ? match(c.st, co, id, body as unknown as MatchRequest, ACTOR)
      : cmd === 'post' ? post(c.st, co, id, body as unknown as PostRequest, ACTOR)
        : cmd === 'unmatch' ? unmatch(c.st, co, id, ACTOR, reason) : cmd === 'ignore' ? ignore(c.st, co, id, ACTOR, reason) : unignore(c.st, co, id, ACTOR, reason);
    persist(c.st);
    return HttpResponse.json(line);
  }))),
];
