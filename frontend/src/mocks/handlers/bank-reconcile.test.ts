import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { BankLine, Doc } from '@/domain/types';
import type { ReportModel } from '@/domain/reports';
import { setSettings } from '../settings';
import { loadState, resetState } from '../store';
import { testServer } from '../test-server';

beforeAll(() => testServer.listen({ onUnhandledFrame: 'error' }));
afterEach(() => testServer.resetHandlers());
afterAll(() => testServer.close());
beforeEach(() => { localStorage.clear(); resetState(); setSettings({ companyKey: 'vat', role: 'accountant', screenState: 'normal' }); });

const call = (method: string, p: string, body?: unknown) =>
  fetch(`http://localhost/bff/v1${p}`, { method, body: body ? JSON.stringify(body) : undefined, headers: { 'content-type': 'application/json' } });
const L = '/finance/bank-lines/bi-001-003';

describe('reconciliation over HTTP', () => {
  it('match -> the receipt reads with the reconciliation lock, its cancel is refused 409, unmatch frees it', async () => {
    const m = await call('POST', `${L}/match`, { docIds: ['rc-013'] });
    expect(m.status).toBe(200);
    expect(((await m.json()) as BankLine)).toMatchObject({ status: 'matched', matches: [{ docId: 'rc-013', amount: '6955.00' }] });
    const doc = (await (await call('GET', '/docs/RC/rc-013')).json()) as Doc;
    expect(doc.locks.find((l) => l.kind === 'reconciliation')).toMatchObject({ exits: ['ยกเลิกการจับคู่'], href: '/finance/bank-accounts/ba-kbank?line=bi-001-003' });
    const c = await call('POST', '/docs/RC/rc-013/cancel', { version: doc.version, reasonCode: 'X', reasonText: 'ทดสอบ' });
    expect(c.status).toBe(409);
    expect(((await c.json()) as { code: string }).code).toBe('doc.reconciled');
    expect((await call('POST', `${L}/unmatch`, {})).status).toBe(200);
    expect(((await (await call('GET', '/docs/RC/rc-013')).json()) as Doc).locks.some((l) => l.kind === 'reconciliation')).toBe(false);
  });

  it('a refused match is a problem+json with its code and writes nothing', async () => {
    const r = await call('POST', `${L}/match`, { docIds: ['rc-012'] }); // 64,200 against a 6,955 line
    expect(r.status).toBe(422);
    expect(((await r.json()) as { code: string }).code).toBe('bank.match_amount');
    expect(loadState().bankLines.find((l) => l.id === 'bi-001-003')!.status).toBe('unmatched');
    expect(loadState().bankJournals.filter((j) => j.kind !== 'opening')).toHaveLength(0);
  });

  it('every reconciliation command needs bank.reconcile: operator and admin are refused 403, and nothing is written', async () => {
    for (const role of ['operator', 'admin'] as const) {
      setSettings({ companyKey: 'vat', role, screenState: 'normal' });
      for (const [method, p, body] of [['POST', `${L}/match`, { docIds: ['rc-013'] }], ['POST', `${L}/ignore`, {}], ['POST', `${L}/post`, { accountCode: '5200' }], ['GET', `${L}/candidates`], ['POST', '/finance/bank-accounts/ba-kbank/reconciled-to', { date: '2026-09-01' }], ['GET', '/finance/postable-accounts']] as const) {
        expect((await call(method, p, body)).status, `${role} ${p}`).toBe(403);
      }
    }
    expect(loadState().bankLines.every((l) => l.status === 'unmatched')).toBe(true);
  });

  it('candidates: the suggestion for the line, a search for others; the lines list carries matches and locked', async () => {
    const s = (await (await call('GET', `${L}/candidates`)).json()) as { items: { docId: string; exact: boolean }[] };
    expect(s.items.map((c) => [c.docId, c.exact])).toEqual([['rc-013', true]]);
    const q = (await (await call('GET', `${L}/candidates?q=RC-2026`)).json()) as { items: { docId: string }[] };
    expect(q.items.length).toBeGreaterThan(5);
    expect((await call('GET', '/finance/bank-lines/nope/candidates')).status).toBe(404);
    await call('POST', `${L}/match`, { docIds: ['rc-013'] });
    const page = (await (await call('GET', '/finance/bank-accounts/ba-kbank/lines?line=bi-001-003')).json()) as { items: BankLine[] };
    expect(page.items).toHaveLength(1);
    expect(page.items[0].matches![0].number).toBe('RC-202609-0001');
  });

  it('postable accounts hide the VAT / WHT control accounts; a refused journal is a 422 with the rule', async () => {
    const accts = (await (await call('GET', '/finance/postable-accounts')).json()) as { code: string; party?: string }[];
    const codes = accts.map((a) => a.code);
    for (const hidden of ['1170', '2151', '1180', '2131', '2133', '2152']) expect(codes).not.toContain(hidden);
    expect(accts.find((a) => a.code === '1130')!.party).toBe('customer');
    const r = await call('POST', '/finance/bank-lines/bi-001-017/post', { accountCode: '2151' });
    expect(r.status).toBe(422);
    expect(((await r.json()) as { code: string }).code).toBe('ledger.control_account');
    const ok = await call('POST', '/finance/bank-lines/bi-001-017/post', { accountCode: '5200', description: 'ค่าธรรมเนียม' });
    expect(ok.status).toBe(200);
    expect(loadState().bankJournals.at(-1)).toMatchObject({ kind: 'inline', lineId: 'bi-001-017' });
  });

  it('lock to a date over HTTP, then the lines read locked and the account reports the date', async () => {
    const e = await call('POST', '/finance/bank-accounts/ba-kbank/reconciled-to', { date: '2026-09-05' });
    expect(e.status).toBe(422);
    expect(((await e.json()) as { code: string }).code).toBe('bank.lock_unmatched');
    for (const id of ['bi-001-001', 'bi-001-002']) await call('POST', `/finance/bank-lines/${id}/ignore`, {});
    await call('POST', `${L}/match`, { docIds: ['rc-013'] });
    expect((await call('POST', '/finance/bank-accounts/ba-kbank/reconciled-to', { date: '2026-09-05' })).status).toBe(200);
    const rec = (await (await call('GET', '/finance/bank-accounts/ba-kbank/reconciliation')).json()) as { reconciledTo: string; counts: Record<string, number> };
    expect(rec).toMatchObject({ reconciledTo: '2026-09-05', counts: { matched: 1, ignored: 2, unmatched: 15 } });
    const u = await call('POST', `${L}/unmatch`, {});
    expect(u.status).toBe(422);
    expect(((await u.json()) as { code: string }).code).toBe('bank.reason_required');
    expect((await call('POST', `${L}/unmatch`, { reason: 'ผิดใบ' })).status).toBe(200);
  });
});

describe('the bank-reconciliation report endpoint', () => {
  it('ties out on the seed, needs an account, answers 404 for another company\'s account, and exports CSV', async () => {
    const r = await call('GET', '/reports/bank-reconciliation?account=ba-kbank&to=2026-09-30');
    expect(r.status).toBe(200);
    const m = (await r.json()) as ReportModel;
    expect(m).toMatchObject({ kind: 'bank-reconciliation', tieOuts: [{ diff: '0.00' }] });
    expect(m.rows.some((x) => x.kind === 'group')).toBe(true);
    expect(((await (await call('GET', '/reports/bank-reconciliation?to=2026-09-30')).json()) as { code: string }).code).toBe('report.bad_param');
    expect((await call('GET', '/reports/bank-reconciliation?account=nba-kbank&to=2026-09-30')).status).toBe(404);
    const csv = await call('GET', '/reports/bank-reconciliation/export?account=ba-kbank&to=2026-09-30');
    expect(csv.status).toBe(200);
    expect(await csv.text()).toContain('ยอดคงเหลือตาม statement');
    setSettings({ companyKey: 'vat', role: 'operator', screenState: 'normal' });
    expect((await call('GET', '/reports/bank-reconciliation?account=ba-kbank&to=2026-09-30')).status).toBe(403);
  });
});
