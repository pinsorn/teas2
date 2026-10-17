import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import type { DocLine } from '@/domain/types';
import { USER as me } from '../fixtures/documents';
import { createDraft, issue } from '../engine/commands';
import { setSettings } from '../settings';
import { loadState, resetState, saveState } from '../store';
import { testServer } from '../test-server';

// TX2b review F5: the finalize handler reads `ack` strictly (`=== true`): a ภ.พ.36 finalizes only with the boolean true
beforeAll(() => testServer.listen({ onUnhandledFrame: 'error' }));
afterEach(() => testServer.resetHandlers());
afterAll(() => testServer.close());
beforeEach(() => { localStorage.clear(); resetState(); setSettings({ companyKey: 'vat', role: 'accountant', screenState: 'normal' }); });
const call = (method: string, p: string, body?: unknown) => fetch(`http://localhost/bff/v1${p}`, { method, body: body ? JSON.stringify(body) : undefined, headers: { 'content-type': 'application/json' } });

it('PP36 finalize: no ack / a truthy string -> 422 filing.ack_required and nothing written; ack true -> filed', async () => {
  const st = loadState();
  const line: DocLine = { id: 'a', description: 'บริการ', qty: '1', unit: 'งาน', unitPrice: '357.14', taxCode: 'EX', expenseCategory: 'services', whtTypeCode: 'FOR-SVC', pnd36: true };
  const d = createDraft(st, 'co-vat', 'PV', { header: { partyId: 'pv-12', documentDate: '2026-09-10' }, lines: [line] }, me, 'ack-1');
  issue(st, d.id, d.version, me);
  saveState(st);
  const version = ((await (await call('GET', '/filings/PP36/2026-09')).json()) as { version: number }).version;
  for (const body of [{ version }, { version, ack: 'true' }, { version, ack: 1 }]) {
    const r = await call('POST', '/filings/PP36/2026-09/finalize', body);
    expect(r.status).toBe(422);
    expect(((await r.json()) as { code: string }).code).toBe('filing.ack_required');
  }
  expect(loadState().filings.some((f) => f.form === 'PP36' && f.period === '2026-09')).toBe(false);
  expect((await call('POST', '/filings/PP36/2026-09/finalize', { version, ack: true })).status).toBe(200);
  expect(loadState().filings.some((f) => f.form === 'PP36' && f.period === '2026-09')).toBe(true);
});
