import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setSettings } from '../settings';
import { resetState } from '../store';
import { testServer } from '../test-server';

beforeAll(() => testServer.listen({ onUnhandledFrame: 'error' }));
afterEach(() => testServer.resetHandlers());
afterAll(() => testServer.close());
beforeEach(() => { localStorage.clear(); resetState(); setSettings({ companyKey: 'vat', role: 'accountant', screenState: 'normal' }); });

const get = (p: string) => fetch(`http://localhost/bff/v1${p}`);

describe('read handlers', () => {
  it('lists TIs of the active company only, newest first, with a cursor', async () => {
    const r = await (await get('/docs/TI?limit=10')).json();
    expect(r.items).toHaveLength(10);
    expect(r.nextCursor).toBeTruthy();
    expect(r.items[0].documentDate >= r.items[9].documentDate).toBe(true);
  });
  it('filters by status', async () => {
    const r = await (await get('/docs/TI?status=draft&limit=50')).json();
    expect(r.items.every((d: { status: string }) => d.status === 'draft')).toBe(true);
  });
  it('screen state "error" returns problem+json 500, "empty" returns no rows, "forbidden" returns 403', async () => {
    setSettings({ screenState: 'error' });
    const e = await get('/docs/TI');
    expect(e.status).toBe(500);
    expect((await e.json()).code).toBe('mock.server_error');
    setSettings({ screenState: 'empty' });
    expect((await (await get('/docs/TI')).json()).items).toEqual([]);
    setSettings({ screenState: 'forbidden' });
    expect((await get('/docs/TI')).status).toBe(403);
  });
  it('non-VAT company has no TI list', async () => {
    setSettings({ companyKey: 'nonvat' });
    const r = await get('/docs/TI');
    expect(r.status).toBe(404);
    expect((await r.json()).code).toBe('doc.type_not_available');
  });
  it('a role without doc.TI.read is refused', async () => {
    setSettings({ role: 'admin' });
    expect((await get('/docs/TI')).status).toBe(403);
  });
});
