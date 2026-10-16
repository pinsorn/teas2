import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setSettings } from '../settings';
import { loadState, resetState } from '../store';
import { testServer } from '../test-server';

beforeAll(() => testServer.listen({ onUnhandledFrame: 'error' }));
afterEach(() => testServer.resetHandlers());
afterAll(() => testServer.close());
beforeEach(() => { localStorage.clear(); resetState(); setSettings({ companyKey: 'vat', role: 'accountant', screenState: 'normal' }); });

const call = (method: string, p: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(`http://localhost/bff/v1${p}`, { method, body: body ? JSON.stringify(body) : undefined, headers: { 'content-type': 'application/json', ...headers } });
const line = (extra: Record<string, unknown> = {}) => ({ id: 'l1', description: 'ค่าเช่า', qty: '1', unit: 'เดือน', unitPrice: '1000.00', taxCode: 'S7', ...extra });
const bill = (header: Record<string, unknown> = {}, lines = [line()]) => ({ header: { partyId: 'pv-01', documentDate: '2026-10-14', ...header }, lines });
const make = async (type: string, b: unknown) => (await call('POST', `/docs/${type}`, b)).json() as Promise<{ id: string; version: number }>;

describe('purchase documents over the wire (P2)', () => {
  it('the operator records and issues a bill but cannot cancel it or record a vendor note; the accountant can', async () => {
    setSettings({ role: 'operator' });
    const d = await make('PB', bill());
    const issued = await call('POST', `/docs/PB/${d.id}/issue`, { version: d.version });
    expect(issued.status).toBe(200);
    const doc = await issued.json();
    expect((await call('POST', `/docs/PB/${d.id}/cancel`, { version: doc.version, reasonCode: 'OTHER', reasonText: 'x' })).status).toBe(403);
    const note = { header: { documentDate: '2026-10-14', refDocId: d.id, reasonCode: 'RETURN' }, lines: [line({ sourceLineId: 'l1' })] };
    expect((await call('POST', '/docs/PCN', note)).status).toBe(403);
    expect((await call('GET', '/docs/PCN')).status).toBe(200); // read is the operator's
    setSettings({ role: 'accountant' });
    expect((await call('POST', '/docs/PCN', note)).status).toBe(201);
    expect((await call('POST', `/docs/PB/${d.id}/cancel`, { version: doc.version, reasonCode: 'OTHER', reasonText: 'x' })).status).toBe(200); // a DRAFT note adjusts nothing yet
  });

  it('input VAT rules are the server\'s: an unregistered vendor, an unknown category and an out-of-range claim period are 422 problems at issue', async () => {
    const issue = async (b: unknown) => { const d = await make('PB', b); return call('POST', `/docs/PB/${d.id}/issue`, { version: d.version }); };
    const unreg = await issue(bill({ partyId: 'pv-12' }));
    expect(unreg.status).toBe(422);
    expect((await unreg.json()).code).toBe('pb.vendor_not_vat_registered');
    expect((await (await issue(bill({}, [line({ expenseCategory: 'whatever' })]))).json()).code).toBe('pb.unknown_category');
    expect((await (await issue(bill({ claimPeriod: '2027-05' }))).json()).code).toBe('pb.claim_period_out_of_range');
    expect((await issue(bill({ claimPeriod: '2027-04' }))).status).toBe(200);
  });

  it('a vendor note takes its vendor, reference and expense category from the bill whatever the client sends; an engine VAT override is stripped', async () => {
    const pb = await make('PB', bill({}, [line({ expenseCategory: 'entertainment' })]));
    await call('POST', `/docs/PB/${pb.id}/issue`, { version: pb.version });
    const n = await (await call('POST', '/docs/PCN', { header: { partyId: 'pv-05', reference: 'ปลอม', documentDate: '2026-10-14', refDocId: pb.id, reasonCode: 'DISCOUNT' },
      lines: [line({ id: 'n1', sourceLineId: 'l1', unitPrice: '100.00', expenseCategory: 'rent', vatOverride: '99.00' })] })).json();
    expect(n.header.partyId).toBe('pv-01');
    expect(n.header.reference).toMatch(/^PB-/);
    expect(n.lines[0].expenseCategory).toBe('entertainment');
    const issued = await (await call('POST', `/docs/PCN/${n.id}/issue`, { version: n.version })).json();
    expect(issued.totals).toMatchObject({ net: '100.00', vat: '7.00', total: '107.00' }); // not the 99.00 the client pushed
    const ledger = await (await call('GET', `/docs/PCN/${n.id}/ledger`)).json();
    expect(ledger.entries[0].lines.map((l: { accountCode: string }) => l.accountCode).sort()).toEqual(['2110', '5150', '5170']); // entertainment: the VAT given back is cost too
    const cancel = await call('POST', `/docs/PB/${pb.id}/cancel`, { version: 2, reasonCode: 'OTHER', reasonText: 'x' });
    expect(cancel.status).toBe(409);
    expect((await cancel.json()).code).toBe('doc.has_dependents'); // the live note stops the bill's cancel
    expect(loadState().docs.find((d) => d.id === pb.id)!.outstanding).toBe('963.00'); // 1,070.00 - 107.00
  });

  it('the list finds a vendor document by the number printed on it, and shows that number as the reference', async () => {
    const r = await (await call('GET', '/docs/PB?q=INV-2026-1007')).json() as { items: { id: string; reference?: string }[] };
    expect(r.items.map((i) => [i.id, i.reference])).toEqual([['pb-1', 'INV-2026-1007']]);
    const po = await (await call('GET', '/docs/PB?q=pb-po')).json() as { items: unknown[] };
    expect(po.items).toHaveLength(0); // an id is not a search key; the converted bill's own vendor number is
    const conv = await (await call('GET', '/docs/PB?q=TX-88/0431')).json() as { items: { id: string; reference?: string }[] };
    expect(conv.items.map((i) => [i.id, i.reference])).toEqual([['pb-po', 'TX-88/0431']]); // the vendor's number wins over the PO number it was converted from
  });

  it('a revise that fails leaves the bill and its journal as they were', async () => {
    const pb = await make('PB', bill());
    const issued = await (await call('POST', `/docs/PB/${pb.id}/issue`, { version: pb.version })).json();
    const before = JSON.stringify(loadState().journals.find((j) => j.docId === pb.id));
    const bad = await call('POST', `/docs/PB/${pb.id}/correction-plan`, { header: { ...issued.header, claimPeriod: '2030-01' }, lines: issued.lines });
    expect(bad.status).toBe(422);
    expect((await bad.json()).code).toBe('pb.claim_period_out_of_range'); // refused before a plan is even shown
    expect(JSON.stringify(loadState().journals.find((j) => j.docId === pb.id))).toBe(before);
  });
});
