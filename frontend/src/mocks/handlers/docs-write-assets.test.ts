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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = async (r: Response) => r.json() as Promise<Record<string, any>>;
const capexLine = { id: 'cl1', description: 'เครื่องมือ', qty: '1', unit: 'ชุด', unitPrice: '12000.00', taxCode: 'EX', expenseCategory: 'capex-equipment' };
/** An issued capex bill dated at the start of the month (so an asset can start on the 1st). */
const bill = async () => {
  const d = await json(await call('POST', '/docs/PB', { header: { partyId: 'pv-10', documentDate: '2026-09-01', vendorDocNumber: 'AC5-1', vendorDocDate: '2026-09-01' }, lines: [capexLine] }));
  return json(await call('POST', `/docs/PB/${d.id}/issue`, { version: d.version }));
};
const register = (b: Record<string, unknown>) => call('POST', '/assets', { source: { kind: 'bill', docId: b.id, lineId: 'cl1' }, lifeMonths: 12, startDate: '2026-09-01' });

describe('fixed assets over the wire (AC5)', () => {
  it('an asset or a depreciation run is never made through the generic document routes (the exit names the screen)', async () => {
    for (const t of ['FA', 'DP']) {
      const r = await call('POST', `/docs/${t}`, { header: { documentDate: '2026-10-01' }, lines: [] });
      expect(r.status, t).toBe(409);
      expect((await json(r)).code).toBe('doc.use_asset_screen');
    }
    expect((await call('PUT', '/docs/FA/fa-nb', { version: 1, header: { documentDate: '2026-10-01' }, lines: [] })).status).toBe(409);
    expect((await call('POST', '/docs/FA/fa-nb/issue', { version: 1 })).status).toBe(409);
    expect((await call('POST', '/docs/DP/compute', { header: { documentDate: '2026-10-01' }, lines: [] })).status).toBe(409);
  });

  it('a caller cannot fabricate a disposal: header.disposal is stripped, so the invoice posts revenue, not an asset removal', async () => {
    const disposal = { date: '2026-10-01', kind: 'sale', name: 'x', cost: '1000.00', accumulated: '0.00', partial: '0.00', nbv: '1000.00', outcome: 'gain', gainLoss: '0.00', proceeds: '1000.00', vat: '70.00', faId: 'fa-nb', codes: { cost: '1210', accumulated: '1211', expense: '5400', gain: '4900', loss: '5900', ar: '1130', vat: '2120' } };
    const d = await json(await call('POST', '/docs/TI', { header: { partyId: 'pc-01', documentDate: '2026-10-14', disposal }, lines: [{ id: 'l1', description: 'งาน', qty: '1', unit: 'งาน', unitPrice: '1000.00', taxCode: 'S7' }] }));
    expect(d.header.disposal).toBeUndefined();
    await call('POST', `/docs/TI/${d.id}/issue`, { version: d.version });
    const ledger = await json(await call('GET', `/docs/TI/${d.id}/ledger`));
    const codes = ledger.entries[0].lines.map((l: { accountCode: string }) => l.accountCode);
    expect(codes).not.toContain('1210');
    expect(codes).not.toContain('1211');
  });

  it('register -> preview -> run -> recompute (latest only) -> dispose by sale -> cancel the invoice', async () => {
    const b = await bill();
    const un = await json(await call('GET', '/assets/unregistered'));
    expect(un.items.some((r: { source: { docId: string } }) => r.source.docId === b.id)).toBe(true);
    const reg = await register(b);
    expect(reg.status).toBe(201);
    const fa = await json(reg);
    expect(fa.asset).toMatchObject({ cost: '12000.00', accumulated: '0.00' });
    expect((await register(b)).status).toBe(409); // fa.source_taken
    // September is due (the seed ran July and August); October is not
    const pv = await json(await call('GET', '/depreciation/preview?month=2026-09'));
    expect(pv.problem).toBeUndefined();
    expect(pv.rows.find((r: { assetId: string }) => r.assetId === fa.id)).toMatchObject({ amount: '1000.00' });
    expect((await json(await call('GET', '/depreciation/preview?month=2026-10'))).problem.code).toBe('dp.out_of_order');
    const run = await call('POST', '/depreciation/runs', { month: '2026-09' });
    expect(run.status).toBe(201);
    const dp = await json(run);
    expect((await json(await call('POST', '/depreciation/runs', { month: '2026-09' }))).code).toBe('dp.already_run');
    expect((await json(await call('POST', '/depreciation/runs', { month: '2026-10' }))).code).toBe('dp.not_due');
    expect((await json(await call('GET', `/docs/FA/${fa.id}`))).asset.accumulated).toBe('1000.00');
    expect((await call('POST', `/docs/DP/${dp.id}/recompute`, { version: dp.version })).status).toBe(200);
    // sale: a tax invoice to the buyer through the normal issue path
    expect((await call('POST', `/docs/FA/${fa.id}/dispose`, { date: '2026-09-25', kind: 'sale', proceeds: '5000.00' })).status).toBe(422); // no buyer
    expect((await call('POST', `/docs/FA/${fa.id}/dispose`, { date: '2026-09-25', kind: 'sale', proceeds: '5000.00', buyerId: 'pc-01' })).status).toBe(409); // fa.dp_after: September is run
    const cur = await json(await call('GET', `/docs/DP/${dp.id}`));
    expect((await call('POST', `/docs/DP/${dp.id}/cancel`, { version: cur.version, reasonCode: 'OTHER', reasonText: 'x' })).status).toBe(200);
    const sold = await call('POST', `/docs/FA/${fa.id}/dispose`, { date: '2026-09-25', kind: 'sale', proceeds: '5000.00', buyerId: 'pc-01' });
    expect(sold.status).toBe(200);
    const faSold = await json(sold);
    const ti = loadState().docs.find((d) => d.id === faSold.asset.disposed.tiId)!;
    expect(ti).toMatchObject({ type: 'TI', status: 'issued', totals: { net: '5000.00', vat: '350.00', total: '5350.00' } });
    expect((await call('POST', `/docs/TI/${ti.id}/cancel`, { version: ti.version, reasonCode: 'OTHER', reasonText: 'x' })).status).toBe(200);
    expect((await json(await call('GET', `/docs/FA/${fa.id}`))).asset.disposed).toBeUndefined(); // the asset is live again
  });

  it('a write-off is undone by its endpoint; terms are edited; the operator changes nothing', async () => {
    const b = await bill();
    const fa = await json(await register(b));
    const off = await call('POST', `/docs/FA/${fa.id}/dispose`, { date: '2026-09-30', kind: 'write_off' });
    expect(off.status).toBe(200);
    expect((await json(off)).asset.disposed).toMatchObject({ kind: 'write_off', outcome: 'loss' });
    expect((await call('POST', `/docs/FA/${fa.id}/undispose`, {})).status).toBe(200);
    const terms = await call('POST', `/docs/FA/${fa.id}/terms`, { lifeMonths: 24, salvage: '100.00' });
    expect((await json(terms)).asset).toMatchObject({ lifeMonths: 24, salvage: '100.00' });
    setSettings({ role: 'operator' });
    expect((await call('GET', '/assets/unregistered')).status).toBe(403); // doc.FA.read is the accountant's
    expect((await call('POST', '/depreciation/runs', { month: '2026-09' })).status).toBe(403);
  });
  it('the register report lists the assets per class and ties the accumulated depreciation to the ledger (both companies)', async () => {
    for (const key of ['vat', 'nonvat'] as const) {
      setSettings({ companyKey: key });
      const r = await json(await call('GET', '/reports/asset-register'));
      expect(r.rows.filter((x: { kind: string }) => x.kind === 'row').length).toBeGreaterThan(0);
      expect(r.tieOuts[0].diff, key).toBe('0.00');
    }
    setSettings({ companyKey: 'vat' });
    const b = await bill();
    const reg = await json(await register(b));
    await call('POST', '/depreciation/runs', { month: '2026-09' });
    const r = await json(await call('GET', '/reports/asset-register'));
    expect(r.rows.find((x: { cells: { number?: string } }) => x.cells.number === reg.number).cells).toMatchObject({ cost: '12000.00', accumulated: '1000.00', nbv: '11000.00' });
    expect(r.tieOuts[0].diff).toBe('0.00');
  });
});
