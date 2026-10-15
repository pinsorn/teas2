import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { OpenItem } from '@/domain/types';
import { toSatang } from '../engine/money';
import { fixtureIds } from '../fixtures/ids';
import { setSettings } from '../settings';
import { loadState, resetState, saveState } from '../store';
import { testServer } from '../test-server';

beforeAll(() => testServer.listen({ onUnhandledFrame: 'error' }));
afterEach(() => testServer.resetHandlers());
afterAll(() => testServer.close());
beforeEach(() => { localStorage.clear(); resetState(); setSettings({ companyKey: 'vat', role: 'accountant', screenState: 'normal' }); });

const get = (p: string) => fetch(`http://localhost/bff/v1${p}`);

describe('GET /docs/open-items', () => {
  it('lists the party live documents with an outstanding balance, oldest first, outstanding as the server string', async () => {
    const r = await get('/docs/open-items?partyId=pc-01&types=TI,IV');
    expect(r.status).toBe(200);
    const body = (await r.json()) as { items: OpenItem[]; total: string };
    const items = body.items;
    const st = loadState();
    const expected = st.docs.filter((d) => d.type === 'TI' && d.header.partyId === 'pc-01' && ['issued', 'partly_settled'].includes(d.status) && Number(d.outstanding) !== 0);
    expect(items.length).toBe(expected.length);
    expect(items.length).toBeGreaterThanOrEqual(2);
    for (const i of items) expect(i).toMatchObject({ type: 'TI', outstanding: st.docs.find((d) => d.id === i.id)!.outstanding, total: st.docs.find((d) => d.id === i.id)!.totals.total });
    expect(items.map((i) => i.documentDate)).toEqual([...items.map((i) => i.documentDate)].sort());
    expect(items.map((i) => i.id)).toContain(fixtureIds(st).rcTargetsA);
    // the total is the server's sum of the very rows it returned (the browser never adds money)
    expect(toSatang(body.total)).toBe(items.reduce((a, i) => a + toSatang(i.outstanding), 0));
  });
  it('excludes settled, replaced and draft documents and other parties', async () => {
    const items = ((await (await get('/docs/open-items?partyId=pc-01&types=TI')).json()) as { items: OpenItem[] }).items;
    const st = loadState();
    for (const i of items) {
      const d = st.docs.find((x) => x.id === i.id)!;
      expect([d.header.partyId, ['issued', 'partly_settled'].includes(d.status)]).toEqual(['pc-01', true]);
    }
  });
  it('shows a negative outstanding (a credit note after full payment) and never clamps it', async () => {
    const st = loadState();
    const ti = st.docs.find((d) => d.type === 'TI' && d.status === 'settled')!;
    const cn = st.docs.find((d) => d.type === 'CN')!;
    st.links.push({ companyId: ti.companyId, from: cn.id, to: ti.id, kind: 'adjusts', amount: '10.00', active: true });
    saveState(st);
    const items = ((await (await get(`/docs/open-items?partyId=${ti.header.partyId}&types=TI`)).json()) as { items: OpenItem[] }).items;
    expect(items.find((i) => i.id === ti.id)?.outstanding).toBe('-10.00');
  });
  it('a type the company cannot use is skipped (IV for a VAT company), not an error', async () => {
    const r = await get('/docs/open-items?partyId=pc-01&types=IV');
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ items: [], total: '0.00' });
  });
  it('422 without a party or with a type that carries no balance; 403 without the read permission; screen states apply', async () => {
    expect((await get('/docs/open-items?types=TI')).status).toBe(422);
    expect((await get('/docs/open-items?partyId=pc-01&types=QT')).status).toBe(422);
    setSettings({ role: 'admin' });
    const f = await get('/docs/open-items?partyId=pc-01&types=TI');
    expect(f.status).toBe(403);
    expect((await f.json()).detail).toContain('doc.TI.read');
    setSettings({ role: 'accountant', screenState: 'error' });
    expect((await get('/docs/open-items?partyId=pc-01&types=TI')).status).toBe(500);
  });
});

describe('reference lists for the receipt / payment editors', () => {
  it('bank accounts of the active company with the default flag; non-VAT company sees its own', async () => {
    const vat = (await (await get('/bank-accounts')).json()) as { id: string; default?: boolean }[];
    expect(vat.map((b) => b.id)).toEqual(['ba-kbank', 'ba-scb', 'ba-cash']);
    expect(vat.filter((b) => b.default).map((b) => b.id)).toEqual(['ba-kbank']);
    setSettings({ companyKey: 'nonvat', role: 'operator' });
    expect(((await (await get('/bank-accounts')).json()) as { id: string }[]).map((b) => b.id)).toEqual(['nba-kbank', 'nba-cash']);
  });
  it('WHT types [SP-R]: code, name, rate text; forbidden without a receipt / voucher read', async () => {
    const t = (await (await get('/wht-types')).json()) as { code: string; rate: string }[];
    expect(t.find((x) => x.code === 'SVC')?.rate).toBe('3%');
    expect(t.find((x) => x.code === 'AGRI')?.rate).toBe('0.75%');
    expect(t).toHaveLength(16);
    setSettings({ role: 'admin' });
    expect((await get('/wht-types')).status).toBe(403);
    expect((await get('/bank-accounts')).status).toBe(403);
  });
});
