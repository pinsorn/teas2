import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setSettings } from '../settings';
import { loadState, resetState } from '../store';
import { testServer } from '../test-server';

beforeAll(() => testServer.listen({ onUnhandledFrame: 'error' }));
afterEach(() => testServer.resetHandlers());
afterAll(() => testServer.close());
beforeEach(() => { localStorage.clear(); resetState(); setSettings({ companyKey: 'vat', role: 'accountant', screenState: 'normal' }); });

const call = (method: string, p: string, body?: unknown) =>
  fetch(`http://localhost/bff/v1${p}`, { method, body: body ? JSON.stringify(body) : undefined, headers: { 'content-type': 'application/json' } });
const pv = (whtMode: unknown) => ({ header: { partyId: 'pv-03', documentDate: '2026-10-14', whtMode }, lines: [{ id: 'l1', description: 'x', qty: '1', unit: 'u', unitPrice: '100.00', taxCode: 'EX' }] });
const refused = async (r: Response) => { const j = await r.json(); return [r.status, j.code, String(j.title ?? j.detail)] as const; };

describe('an unknown whtMode is refused where the request enters (422), naming the allowed modes', () => {
  it('create, update, compute and a correction plan', async () => {
    const [status, code, title] = await refused(await call('POST', '/docs/PV', pv('bogus')));
    expect([status, code]).toEqual([422, 'wht.mode_invalid']);
    for (const m of ['deduct', 'grossup_once', 'grossup_always']) expect(title).toContain(m);
    expect((await call('POST', '/docs/PV/compute', pv('bogus'))).status).toBe(422);
    const ok = await call('POST', '/docs/PV', pv('grossup_once'));
    expect(ok.status).toBe(201);
    const d = (await ok.json()) as { id: string; version: number };
    expect((await refused(await call('PUT', `/docs/PV/${d.id}`, { ...pv('nope'), version: d.version })))[1]).toBe('wht.mode_invalid');
    const issued = loadState().docs.find((x) => x.type === 'PV' && x.status === 'issued' && x.companyId === 'co-vat')!;
    expect((await refused(await call('POST', `/docs/PV/${issued.id}/correction-plan`, { header: { ...issued.header, whtMode: 'bogus' }, lines: issued.lines })))[1]).toBe('wht.mode_invalid');
  });
});
