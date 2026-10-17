import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DESCRIPTORS } from '@/descriptors';
import { setSettings } from '../settings';
import { PERMISSIONS_BY_ROLE } from '../permissions';
import { today } from '../engine/log';
import { fixtureIds } from '../fixtures/ids';
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
    expect((await json('/docs/QT?limit=100')).items.map((d: { id: string }) => d.id)).toContain('qt-nv-1');
    expect((await json('/docs/QT?limit=100')).items.map((d: { id: string }) => d.id)).not.toContain('qt-c1');
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

describe('search hrefs come from the registry', () => {
  it('a built type links to its view route; an unbuilt type has no href (never a wrong path)', async () => {
    const ti = loadState().docs.find((d) => d.type === 'TI' && d.companyId === 'co-vat' && d.number)!;
    const qt = loadState().docs.find((d) => d.type === 'CN' && d.companyId === 'co-vat' && d.number)!;
    const t = (await json(`/search?q=${ti.number}`)).items.find((h: { id: string }) => h.id === ti.id);
    expect(t.href).toBe(`/sales/tax-invoices/${ti.id}`);
    expect((await json(`/search?q=${qt.number}`)).items.find((h: { id: string }) => h.id === qt.id).href).toBe(`/sales/credit-notes/${qt.id}`);
    const cn = DESCRIPTORS.CN; // a type without screens has no href: the registry decides
    delete DESCRIPTORS.CN;
    try {
      const q = (await json(`/search?q=${qt.number}`)).items.find((h: { id: string }) => h.id === qt.id);
      expect(q).toBeDefined();
      expect(q.href).toBeUndefined();
    } finally { DESCRIPTORS.CN = cn; }
    const built = loadState().docs.find((d) => d.type === 'QT' && d.companyId === 'co-vat' && d.number)!;
    expect((await json(`/search?q=${built.number}`)).items.find((h: { id: string }) => h.id === built.id).href).toBe(`/sales/quotations/${built.id}`);
  });
});

describe('doc detail, locked, forbidden', () => {
  it('a pre-wave stored session (v2 key, paid TI, locks: []) reseeds and the paid TI shows its settlement lock', async () => {
    const state = loadState();
    const paid = state.docs.find((d) => d.type === 'TI' && d.status === 'settled')!;
    paid.locks = [];
    localStorage.setItem('teas2.mock.state.v2', JSON.stringify({ ...state, version: 2 }));
    localStorage.removeItem('teas2.mock.state.v27');
    expect(loadState().version).toBe(45);
    expect(loadState().docs.find((d) => d.id === paid.id)!.locks).toContainEqual(expect.objectContaining({ kind: 'settlement' }));
  });
  it('GET derives the period lock for a document dated in a closed month, and not for an open-month one (F4)', async () => {
    const state = loadState();
    const ids = fixtureIds(state);
    expect((await json('/docs/TI/' + ids.tiPeriodLocked)).locks).toEqual([expect.objectContaining({ kind: 'period', exits: expect.arrayContaining([expect.stringContaining('แก้ไขย้อนหลัง')]) })]);
    expect((await json('/docs/TI/' + ids.tiIssuedUnpaid)).locks).toEqual([]);
  });
  it('GET derives the settlement lock on read even when the stored doc has locks: []', async () => {
    const state = loadState();
    const paid = state.docs.find((d) => d.type === 'TI' && d.status === 'settled')!;
    paid.locks = [];
    localStorage.setItem('teas2.mock.state.v27', JSON.stringify(state));
    const doc = await json(`/docs/TI/${paid.id}`);
    expect(doc.locks).toContainEqual(expect.objectContaining({ kind: 'settlement' }));
  });
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
        const one = list.find((x: { number?: string }) => x.number); // drafts carry no number
        expect((await get(`/docs/${t}/${one.id}`)).status).toBe(200);
        expect((await json(`/search?q=${one.number}`)).items.some((h: { id: string }) => h.id === one.id)).toBe(true);
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

describe('F3 list filters (overdue, agent) are server-side, applied before paging', () => {
  const ids = (r: { items: { id: string }[] }) => r.items.map((i) => i.id).sort();
  it('overdue=1 returns exactly the documents past due that still owe money, across pages', async () => {
    const st = loadState();
    const ti = st.docs.filter((d) => d.companyId === 'co-vat' && d.type === 'TI');
    const expected = ti.filter((d) => !!d.header.dueDate && d.header.dueDate < today() && Number(d.outstanding ?? 0) > 0).map((d) => d.id).sort();
    expect(expected.length).toBeGreaterThan(0);
    expect(expected.length).toBeLessThan(ti.length);
    const page1 = await (await get('/docs/TI?overdue=1&limit=1')).json();
    expect(page1.total).toBe(expected.length); // filtered BEFORE paging, so the total is the overdue count
    const all = await (await get('/docs/TI?overdue=1&limit=100')).json();
    expect(ids(all)).toEqual(expected);
  });
  it('agent=1 returns only documents an agent created', async () => {
    const expected = loadState().docs.filter((d) => d.companyId === 'co-vat' && d.type === 'TI' && d.createdBy.kind === 'agent').map((d) => d.id).sort();
    expect(expected.length).toBeGreaterThan(0);
    expect(ids(await (await get('/docs/TI?agent=1&limit=100')).json())).toEqual(expected);
  });
});

describe('D-09 ledger.read gates journals', () => {
  const issued = () => loadState().docs.find((d) => d.companyId === 'co-vat' && d.type === 'TI' && d.status === 'issued')!;
  const compute = (d: ReturnType<typeof issued>) => fetch('http://localhost/bff/v1/docs/TI/compute', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ header: d.header, lines: d.lines }) });
  it('/ledger is 403 naming ledger.read for an operator (who can read the document), 200 for an accountant', async () => {
    const d = issued();
    setSettings({ role: 'operator' });
    expect(PERMISSIONS_BY_ROLE.operator).toContain('doc.TI.read');
    const r = await get(`/docs/TI/${d.id}/ledger`);
    expect(r.status).toBe(403);
    expect((await r.json()).detail).toContain('ledger.read');
    setSettings({ role: 'accountant' });
    expect((await get(`/docs/TI/${d.id}/ledger`)).status).toBe(200);
  });
  it('compute omits journal without ledger.read and includes it with', async () => {
    const d = issued();
    setSettings({ role: 'operator' });
    const op = await (await compute(d)).json();
    expect(op.totals).toBeTruthy();
    expect('journal' in op).toBe(false);
    setSettings({ role: 'accountant' });
    expect((await (await compute(d)).json()).journal.entries.length).toBeGreaterThan(0);
  });
});

describe('/ledger needs BOTH ledger.read and the document read permission', () => {
  it('ledger.read alone is not enough', async () => {
    const d = loadState().docs.find((x) => x.companyId === 'co-vat' && x.type === 'TI' && x.status === 'issued')!;
    const saved = PERMISSIONS_BY_ROLE.accountant;
    try {
      PERMISSIONS_BY_ROLE.accountant = saved.filter((p) => p !== 'doc.TI.read');
      expect(PERMISSIONS_BY_ROLE.accountant).toContain('ledger.read');
      const r = await get(`/docs/TI/${d.id}/ledger`);
      expect(r.status).toBe(403);
      expect((await r.json()).detail).toContain('doc.TI.read');
    } finally { PERMISSIONS_BY_ROLE.accountant = saved; }
  });
});
