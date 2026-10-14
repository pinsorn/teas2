import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setSettings } from '../settings';
import { PERMISSIONS_BY_ROLE } from '../permissions';
import { loadState, resetState, saveState } from '../store';
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
  it('filters by a comma-separated status list', async () => {
    const r = await (await get('/docs/TI?status=issued,partly_settled&limit=100')).json();
    const seen = new Set(r.items.map((d: { status: string }) => d.status));
    expect([...seen].sort()).toEqual(['issued', 'partly_settled']);
  });
  it('I5: outstanding=positive keeps only documents that still owe money', async () => {
    const all = (await (await get('/docs/TI?limit=100')).json()).items as { outstanding?: string; status: string }[];
    const r = (await (await get('/docs/TI?outstanding=positive&limit=100')).json()).items as { outstanding?: string }[];
    expect(r.length).toBeGreaterThan(0);
    expect(r.length).toBeLessThan(all.length);
    expect(r.every((d) => Number(d.outstanding) > 0)).toBe(true);
    expect(all.filter((d) => Number(d.outstanding) > 0)).toHaveLength(r.length);
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

const json = async (p: string) => (await get(p)).json();
const post = (p: string, body: unknown) =>
  fetch(`http://localhost/bff/v1${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('tenant isolation', () => {
  /** Plants a non-VAT-company copy of a VAT-company record into the stored state. */
  function plant() {
    const s = loadState();
    const qt = s.docs.find((d) => d.type === 'QT' && d.companyId === 'co-vat')!;
    s.docs.push({ ...qt, id: 'qt-nv-1', number: 'QT-NV-0001', companyId: 'co-nonvat' });
    const p = s.parties.find((x) => x.companyId === 'co-vat')!;
    s.parties.push({ ...p, id: 'zz-party', name: 'ZZ-NONVAT-PARTY', companyId: 'co-nonvat' });
    const i = s.items.find((x) => x.companyId === 'co-vat')!;
    s.items.push({ ...i, id: 'zz-item', name: 'ZZ-NONVAT-ITEM', companyId: 'co-nonvat' });
    saveState(s);
  }
  beforeEach(plant);

  it('docs of another company are absent from list and detail (404) and present for their own company', async () => {
    expect((await json('/docs/QT?limit=100')).items.map((d: { id: string }) => d.id)).not.toContain('qt-nv-1');
    expect((await get('/docs/QT/qt-nv-1')).status).toBe(404);
    setSettings({ companyKey: 'nonvat' });
    expect((await json('/docs/QT')).items.map((d: { id: string }) => d.id)).toEqual(['qt-nv-1']);
    expect((await get('/docs/QT/qt-nv-1')).status).toBe(200);
  });
  it('parties and items are scoped to the active company', async () => {
    expect((await json('/parties?q=ZZ-NONVAT')).items).toEqual([]);
    expect((await json('/items?q=ZZ-NONVAT')).items).toEqual([]);
    setSettings({ companyKey: 'nonvat' });
    expect((await json('/parties?q=ZZ-NONVAT')).items.map((p: { id: string }) => p.id)).toEqual(['zz-party']);
    expect((await json('/items?q=ZZ-NONVAT')).items.map((p: { id: string }) => p.id)).toEqual(['zz-item']);
  });
  it('search returns only active-company hits', async () => {
    expect((await json('/search?q=QT-NV')).items).toEqual([]);
    expect((await json('/search?q=ZZ-NONVAT')).items).toEqual([]);
    setSettings({ companyKey: 'nonvat' });
    const hits = (await json('/search?q=QT-NV')).items;
    expect(hits.map((h: { id: string }) => h.id)).toEqual(['qt-nv-1']);
    expect((await json('/search?q=ZZ-NONVAT')).items.map((h: { id: string }) => h.id)).toEqual(['zz-party']);
  });
});

describe('doc detail, locked, forbidden', () => {
  const firstId = async (q: string) => (await json(`/docs/TI?${q}`)).items[0].id as string;

  it('returns the full document with its party and lines', async () => {
    const id = await firstId('status=settled&limit=1');
    const d = await json(`/docs/TI/${id}`);
    expect([d.id, d.type, d.status]).toEqual([id, 'TI', 'settled']);
    expect(d.lines.length).toBeGreaterThan(0);
    expect(d.party.name).toBeTruthy();
    expect(d.totals.total).toMatch(/^\d+\.\d{2}$/);
    expect((await get('/docs/TI/nope')).status).toBe(404);
    expect((await get(`/docs/QT/${id}`)).status).toBe(404);
  });
  it('locked screen state adds the filing lock to issued docs only', async () => {
    const unlocked = (await json('/docs/TI?status=settled&limit=100')).items as { id: string }[];
    let settled = '';
    for (const d of unlocked) if (!(await json(`/docs/TI/${d.id}`)).locks.some((l: { kind: string }) => l.kind === 'filing')) { settled = d.id; break; }
    expect(settled).not.toBe('');
    const draft = await firstId('status=draft&limit=1');
    expect((await json(`/docs/TI/${settled}`)).locks.filter((l: { kind: string }) => l.kind === 'filing')).toHaveLength(0);
    setSettings({ screenState: 'locked' });
    const locks = (await json(`/docs/TI/${settled}`)).locks.filter((l: { kind: string }) => l.kind === 'filing');
    expect(locks).toHaveLength(1);
    expect(locks[0]).toMatchObject({ kind: 'filing', reason: 'ภ.พ.30 เดือน ก.ย. 2569 ยื่นแล้ว' });
    expect((await json(`/docs/TI/${draft}`)).locks).toEqual([]);
  });
  it('admin is refused on list and detail with the permission named', async () => {
    const id = await firstId('limit=1');
    setSettings({ role: 'admin' });
    const r = await get(`/docs/TI/${id}`);
    expect(r.status).toBe(403);
    expect((await r.json()).detail).toContain('doc.TI.read');
  });
  it('SO, DO, CN and DN seeds are readable by operator and accountant via list, detail, search and home', async () => {
    for (const role of ['accountant', 'operator'] as const) {
      setSettings({ role });
      for (const t of ['SO', 'DO', 'CN']) {
        const list = (await json(`/docs/${t}?limit=100`)).items;
        expect(list.length, `${role} ${t}`).toBeGreaterThan(0);
        expect((await get(`/docs/${t}/${list[0].id}`)).status).toBe(200);
        expect((await json(`/search?q=${list[0].number}`)).items.some((h: { id: string }) => h.id === list[0].id)).toBe(true);
      }
      expect((await get('/docs/DN')).status).toBe(200);
      expect((await get('/home')).status).toBe(200);
    }
  });
});

describe('me follows the active company', () => {
  it('role and permissions agree for the active company after switching', async () => {
    setSettings({ role: 'admin' });
    expect((await post('/me/active-company', { companyId: 'co-nonvat' })).status).toBe(200);
    const me = await json('/me');
    expect(me.activeCompanyId).toBe('co-nonvat');
    expect(me.memberships.find((m: { companyId: string }) => m.companyId === 'co-nonvat').role).toBe('admin');
    expect(me.permissions).toEqual(PERMISSIONS_BY_ROLE.admin);
    setSettings({ role: 'operator' });
    const me2 = await json('/me');
    expect(me2.memberships.find((m: { companyId: string }) => m.companyId === 'co-nonvat').role).toBe('operator');
    expect(me2.permissions).toEqual(PERMISSIONS_BY_ROLE.operator);
  });
});
