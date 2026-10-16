import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DepositRow, Doc, Page, SettlementRecord } from '@/domain/types';
import { checkInvariants } from '../engine/invariants';
import { setSettings } from '../settings';
import { loadState, resetState } from '../store';
import { testServer } from '../test-server';

beforeAll(() => testServer.listen({ onUnhandledFrame: 'error' }));
afterEach(() => testServer.resetHandlers());
afterAll(() => testServer.close());
beforeEach(() => { localStorage.clear(); resetState(); setSettings({ companyKey: 'vat', role: 'accountant', screenState: 'normal' }); });

const call = (method: string, p: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(`http://localhost/bff/v1${p}`, { method, body: body ? JSON.stringify(body) : undefined, headers: { 'content-type': 'application/json', ...headers } });
const apply = { kind: 'apply_deposit', date: '2026-10-14', partyId: 'pc-08', sources: [{ docId: 'rc-dep', amount: '3210.00' }], targets: [{ docId: 'ti-dep', amount: '3210.00' }] };

describe('settlements over HTTP', () => {
  it('lists the deposits with the tolerance and the netting pairs, and the seeded settlement', async () => {
    const d = (await (await call('GET', '/finance/deposits')).json()) as { items: DepositRow[]; tolerance: object; pairs: object[] };
    expect(d.items.map((r) => [r.docId, r.remaining])).toEqual([['rc-dep2', '930.00'], ['pv-prep', '3000.00'], ['rc-dep', '5000.00']]); // oldest first; stl-001 took 1,070.00 of rc-dep2
    expect(d.tolerance).toMatchObject({ rounding: '1.00', smallWriteOff: '100.00' });
    expect(d.pairs).toEqual([expect.objectContaining({ customerId: 'pc-02', vendorId: 'pv-11' })]);
    const l = (await (await call('GET', '/finance/settlements')).json()) as Page<SettlementRecord>;
    expect(l.items.map((s) => s.id)).toEqual(['stl-001']);
    expect((await call('GET', '/finance/settlements/stl-001')).status).toBe(200);
    expect((await call('GET', '/finance/settlements/nope')).status).toBe(404);
  });

  it('post -> the invoice is settled, the deposit reads locked and cancel is 409; reverse frees them; the same Idempotency-Key posts once', async () => {
    const r = await call('POST', '/finance/settlements', apply, { 'Idempotency-Key': 'k1' });
    expect(r.status).toBe(201);
    const s = (await r.json()) as SettlementRecord;
    expect((await call('POST', '/finance/settlements', apply, { 'Idempotency-Key': 'k1' })).status).toBe(201);
    expect(loadState().settlements.filter((x) => x.id === s.id)).toHaveLength(1);
    expect(loadState().settlements).toHaveLength(2);
    const ti = (await (await call('GET', '/docs/TI/ti-dep')).json()) as Doc;
    expect(ti).toMatchObject({ status: 'settled', outstanding: '0.00' });
    expect(ti.locks.find((l) => l.kind === 'settlement' && l.href)).toMatchObject({ exits: ['ย้อนรายการหักกลบ'], href: `/finance/settlements/${s.id}` });
    const rc = (await (await call('GET', '/docs/RC/rc-dep')).json()) as Doc;
    expect((await call('POST', '/docs/RC/rc-dep/cancel', { version: rc.version, reasonCode: 'X', reasonText: 'ทดสอบ' })).status).toBe(409);
    expect(((await (await call('GET', `/docs/TI/ti-dep/chain`)).json()) as { nodes: { id: string; type: string }[] }).nodes.map((n) => n.type)).toContain('STL');
    const v = await call('POST', `/finance/settlements/${s.id}/reverse`, { reason: 'ทดสอบ' });
    expect(v.status).toBe(200);
    expect(((await v.json()) as SettlementRecord).status).toBe('reversed');
    expect((await call('POST', `/finance/settlements/${s.id}/reverse`, {})).status).toBe(409);
    expect(((await (await call('GET', '/docs/TI/ti-dep')).json()) as Doc).locks).toEqual([]);
    expect(checkInvariants(loadState())).toEqual([]);
  });

  it('a refusal is problem+json with its code and writes nothing', async () => {
    const r = await call('POST', '/finance/settlements', { ...apply, difference: { role: 'RoundingDifference', amount: '5.00' }, targets: [{ docId: 'ti-dep', amount: '3215.00' }] });
    expect(r.status).toBe(422);
    expect(((await r.json()) as { code: string }).code).toMatch(/settle\./);
    expect(loadState().settlements).toHaveLength(1);
  });

  it('the operator reads and cannot post or reverse (403); nothing is written; admin can act', async () => {
    setSettings({ companyKey: 'vat', role: 'operator', screenState: 'normal' });
    expect((await call('GET', '/finance/deposits')).status).toBe(200);
    expect((await call('GET', '/finance/settlements')).status).toBe(200);
    expect((await call('POST', '/finance/settlements', apply)).status).toBe(403);
    expect((await call('POST', '/finance/settlements/stl-001/reverse', {})).status).toBe(403);
    expect(loadState().settlements.map((s) => s.status)).toEqual(['posted']);
  });

  it('screen states: empty is an empty list, error is 500, forbidden is 403', async () => {
    setSettings({ companyKey: 'vat', role: 'accountant', screenState: 'empty' });
    expect(((await (await call('GET', '/finance/settlements')).json()) as Page<SettlementRecord>).items).toEqual([]);
    setSettings({ companyKey: 'vat', role: 'accountant', screenState: 'error' });
    expect((await call('GET', '/finance/deposits')).status).toBe(500);
    setSettings({ companyKey: 'vat', role: 'accountant', screenState: 'forbidden' });
    expect((await call('GET', '/finance/settlements')).status).toBe(403);
  });

  it('the non-VAT company has none of the VAT company\'s settlements', async () => {
    setSettings({ companyKey: 'nonvat', role: 'accountant', screenState: 'normal' });
    expect(((await (await call('GET', '/finance/settlements')).json()) as Page<SettlementRecord>).items).toEqual([]);
    expect((await call('GET', '/finance/settlements/stl-001')).status).toBe(404);
    expect((await call('POST', '/finance/settlements/stl-001/reverse', {})).status).toBe(404);
  });
});
