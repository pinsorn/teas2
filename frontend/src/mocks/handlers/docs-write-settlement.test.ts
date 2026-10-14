import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fixtureIds } from '../fixtures/ids';
import { setSettings } from '../settings';
import { loadState, resetState } from '../store';
import { testServer } from '../test-server';
import { stripOverrides } from './docs-write';

beforeAll(() => testServer.listen({ onUnhandledFrame: 'error' }));
afterEach(() => testServer.resetHandlers());
afterAll(() => testServer.close());
beforeEach(() => { localStorage.clear(); resetState(); setSettings({ companyKey: 'vat', role: 'accountant', screenState: 'normal' }); });

const call = (method: string, p: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(`http://localhost/bff/v1${p}`, { method, body: body ? JSON.stringify(body) : undefined, headers: { 'content-type': 'application/json', ...headers } });

describe('allocations through create / update / compute / issue (HTTP)', () => {
  it('compute answers allocated / unallocated / suggested WHT and reports an over-allocation as missing; create stores, update changes, issue settles', async () => {
    const ids = fixtureIds(loadState());
    const rc = (amount: string) => ({ header: { partyId: 'pc-01', documentDate: '2026-10-14' }, lines: [], allocations: [{ targetId: ids.rcTargetsA, targetType: 'TI', amount, wht: '30.00', whtTypeCode: 'SVC' }] });
    const c = await (await call('POST', '/docs/RC/compute', rc('1000.00'))).json();
    expect(c.allocation).toMatchObject({ allocated: '1000.00', unallocated: '0.00' });
    expect(c.totals).toMatchObject({ total: '1000.00', wht: '30.00', cash: '970.00' });
    expect(c.missing).toEqual([]);
    const over = await (await call('POST', '/docs/RC/compute', rc('99999999.00'))).json();
    expect(over.missing.map((m: { field: string }) => m.field)).toEqual(['allocations']);

    const d = await (await call('POST', '/docs/RC', rc('1000.00'), { 'Idempotency-Key': 'rc-1' })).json();
    expect(d.allocations[0]).toMatchObject({ targetId: ids.rcTargetsA, amount: '1000.00' });
    const u = await (await call('PUT', `/docs/RC/${d.id}`, { ...rc('700.00'), version: d.version })).json();
    expect(u.totals.total).toBe('700.00');
    const done = await (await call('POST', `/docs/RC/${d.id}/issue`, { version: u.version })).json();
    expect(done).toMatchObject({ status: 'issued', totals: { total: '700.00', cash: '670.00' } });
    const target = await (await call('GET', `/docs/TI/${ids.rcTargetsA}`)).json();
    expect(target.status).toBe('partly_settled');
    expect(Number(target.outstanding)).toBe(Number(target.totals.total) - 700);
    const chain = await (await call('GET', `/docs/RC/${d.id}/chain`)).json();
    expect(chain.edges.some((e: { kind: string; to: string; wht?: string }) => e.kind === 'settles' && e.to === ids.rcTargetsA && e.wht === '30.00')).toBe(true);
  });
  it('an over-allocation at issue is a 422 problem naming the target; a caller cannot set the engine-set targetNumber', async () => {
    const ids = fixtureIds(loadState());
    const d = await (await call('POST', '/docs/RC', { header: { partyId: 'pc-01', documentDate: '2026-10-14' }, lines: [],
      allocations: [{ targetId: ids.rcTargetsA, targetType: 'TI', amount: '99999999.00', targetNumber: 'FORGED' }] })).json();
    expect(d.allocations[0].targetNumber).toBe(loadState().docs.find((x) => x.id === ids.rcTargetsA)!.number);
    const r = await call('POST', `/docs/RC/${d.id}/issue`, { version: d.version });
    expect(r.status).toBe(422);
    expect((await r.json()).code).toBe('settle.over_allocation');
  });
  it('stripOverrides removes allocation.targetNumber and keeps the certificate number', () => {
    const out = stripOverrides({ header: { documentDate: '2026-10-14' }, lines: [], allocations: [{ targetId: 'a', targetType: 'TI', amount: '1.00', targetNumber: 'X', certNumber: 'C1' }] });
    expect(out.allocations).toEqual([{ targetId: 'a', targetType: 'TI', amount: '1.00', certNumber: 'C1' }]);
  });
});
