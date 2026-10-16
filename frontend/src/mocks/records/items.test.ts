import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { RecordRow } from '@/domain/records';
import type { ItemSummary, Page } from '@/domain/types';
import { RECORDS } from '@/records';
import { GROUP_OF } from '@/records/accounts';
import { chartOfAccounts } from '../fixtures/coa';
import { EXPENSE_CATEGORIES } from '../fixtures/expense-categories';
import { setSettings } from '../settings';
import { loadState, resetState } from '../store';
import { testServer } from '../test-server';

beforeAll(() => testServer.listen({ onUnhandledFrame: 'error' }));
afterEach(() => testServer.resetHandlers());
afterAll(() => testServer.close());
const as = (role: 'operator' | 'accountant' | 'admin', companyKey: 'vat' | 'nonvat' = 'vat') => setSettings({ companyKey, role, screenState: 'normal' });
beforeEach(() => { localStorage.clear(); resetState(); as('accountant'); });

const call = (method: string, path: string, body?: unknown) =>
  fetch(`http://localhost/bff/v1${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
const row = async (id: string) => (await (await call('GET', `/records/item/${id}`)).json()) as RecordRow;
const items = async (query = 'limit=200') => ((await (await call('GET', `/items?${query}`)).json()) as Page<ItemSummary>).items;
const valid = { kind: 'service', code: 'X-01', name: 'ค่าทดสอบ', unit: 'งาน', unitPrice: '1500', taxCode: 'S7', whtTypeCode: 'SVC', usageSales: true, usagePurchase: false };
const PURCHASE_IDS = ['EXP-01', 'EXP-02', 'EXP-03', 'EXP-04', 'EXP-05', 'EXP-06', 'EXP-07', 'EXP-08'];
/** A seeded VAT-company TI line that points at a master item. */
const usedLine = () => {
  const st = loadState();
  const doc = st.docs.find((d) => d.companyId === 'co-vat' && d.type === 'TI' && d.lines.some((l) => l.itemId && st.items.some((i) => i.id === l.itemId)))!;
  return { doc, line: doc.lines.find((l) => l.itemId && st.items.some((i) => i.id === l.itemId))! };
};

describe('expense-category fixture', () => {
  it('maps to accounts that exist in the F4 chart, exactly as the brief names them', () => {
    const coa = new Map(chartOfAccounts().map((a) => [a.code, a]));
    expect(Object.fromEntries(EXPENSE_CATEGORIES.filter((c) => c.accountCode).map((c) => [c.code, c.accountCode]))).toEqual({
      rent: '5110', services: '5120', advertising: '5130', transport: '5140', entertainment: '5150', supplies: '5160', 'cost-of-sales': '5100',
    });
    for (const c of EXPENSE_CATEGORIES.filter((x) => x.accountCode)) expect(coa.get(c.accountCode!), c.code).toMatchObject({ postable: true });
    for (const c of EXPENSE_CATEGORIES.filter((x) => x.accountCode)) expect(GROUP_OF[coa.get(c.accountCode!)!.class], c.code).toBe('expense');
    expect(EXPENSE_CATEGORIES.find((c) => c.code === 'entertainment')!.recoverableVat).toBe(false);
    expect(EXPENSE_CATEGORIES.filter((c) => c.code !== 'entertainment').every((c) => c.recoverableVat)).toBe(true);
    expect(EXPENSE_CATEGORIES.find((c) => c.code === 'capex-equipment')).toMatchObject({ capex: true, assetClass: 'equipment' });
  });
  it('the form offers exactly these categories', () => {
    const f = RECORDS.item!.fields.find((x) => x.key === 'expenseCategory')!;
    expect(f.options!.map((o) => o.value)).toEqual(EXPENSE_CATEGORIES.map((c) => c.code));
  });
});

describe('item fixtures', () => {
  it('seeds the purchase items for both companies with the right usage', () => {
    const st = loadState();
    const vat = st.items.filter((i) => i.companyId === 'co-vat'), nv = st.items.filter((i) => i.companyId === 'co-nonvat');
    expect(vat.filter((i) => i.usage.purchase).map((i) => i.id)).toEqual(PURCHASE_IDS);
    expect(nv.filter((i) => i.usage.purchase).map((i) => i.id)).toEqual(['nv-EXP-01', 'nv-EXP-02', 'nv-EXP-03']);
    expect(vat.filter((i) => !i.id.startsWith('EXP')).every((i) => i.usage.sales && !i.usage.purchase)).toBe(true);
    expect(nv.filter((i) => !i.id.startsWith('nv-EXP')).every((i) => i.usage.sales && !i.usage.purchase)).toBe(true);
    expect(vat.find((i) => i.id === 'EXP-01')).toMatchObject({ name: 'ค่าเช่าสำนักงาน', whtTypeCode: 'RENT', expenseCategory: 'rent', unitPrice: '25000.00', taxCode: 'S7' });
    expect(vat.find((i) => i.id === 'EXP-07')).toMatchObject({ expenseCategory: 'entertainment', taxCode: 'S7' });
    expect(vat.find((i) => i.id === 'EXP-08')).toMatchObject({ kind: 'good', expenseCategory: 'capex-equipment', unitPrice: '32000.00' });
    expect(nv.find((i) => i.id === 'nv-EXP-02')).toMatchObject({ kind: 'good', unit: 'กก.', unitPrice: '12.00', expenseCategory: 'cost-of-sales', taxCode: 'EX' });
  });
  it('every seeded category and WHT type points at something that exists in its company', () => {
    const st = loadState();
    const cats = new Set(EXPENSE_CATEGORIES.map((c) => c.code));
    for (const i of st.items) {
      if (i.expenseCategory) expect(cats.has(i.expenseCategory), i.id).toBe(true);
      if (i.whtTypeCode) expect(st.whtTypes.some((w) => w.companyId === i.companyId && w.code === i.whtTypeCode), i.id).toBe(true);
    }
  });
});

describe('/items type-ahead', () => {
  it('?usage filters: sales items for customers, purchase items for vendors; no usage = everything', async () => {
    expect((await items('usage=sales&limit=200')).length).toBe(20);
    expect((await items('usage=purchase&limit=200')).map((i) => i.id)).toEqual(PURCHASE_IDS);
    expect((await items()).length).toBe(28);
    expect((await call('GET', '/items?usage=bogus')).status).toBe(422);
  });
  it('an item that is both sales and purchase appears under each', async () => {
    const r = await row('SV-01');
    expect((await call('PUT', '/records/item/SV-01', { ...r, usagePurchase: true, version: r.version })).status).toBe(200);
    expect((await items('usage=purchase&limit=200')).some((i) => i.id === 'SV-01')).toBe(true);
    expect((await items('usage=sales&limit=200')).some((i) => i.id === 'SV-01')).toBe(true);
  });
  it('an inactive item is not offered; the records list still has it', async () => {
    const r = await row('SV-02');
    expect((await call('POST', '/records/item/SV-02/active', { active: false, version: r.version })).status).toBe(200);
    expect((await items()).some((i) => i.id === 'SV-02')).toBe(false);
    expect((await row('SV-02')).active).toBe(false);
  });
  it('type-ahead rows carry usage and the category, and never leak companyId or version', async () => {
    const [first] = await items('q=EXP-01');
    expect(first).toMatchObject({ id: 'EXP-01', usage: { sales: false, purchase: true }, expenseCategory: 'rent' });
    expect(first).not.toHaveProperty('companyId');
    expect(first).not.toHaveProperty('version');
  });
});

describe('item record rules', () => {
  it('create: a valid service is stored with normalized money', async () => {
    const r = await call('POST', '/records/item', valid);
    expect(r.status).toBe(201);
    expect((await r.json()) as RecordRow).toMatchObject({ code: 'X-01', unitPrice: '1500.00', taxCode: 'S7', whtTypeCode: 'SVC', usage: 'sales', version: 1, active: true, inUse: false });
  });
  it('validation messages are Thai and keyed by field', async () => {
    const bad = await call('POST', '/records/item', { kind: 'thing', code: '', name: ' ', unit: '', unitPrice: '12.345', taxCode: 'S9', whtTypeCode: 'NOPE',
      usageSales: false, usagePurchase: true, expenseCategory: 'nope' });
    expect(bad.status).toBe(422);
    const fe = (await bad.json()).fieldErrors as Record<string, string[]>;
    expect(Object.keys(fe).sort()).toEqual(['code', 'expenseCategory', 'kind', 'name', 'taxCode', 'unit', 'unitPrice', 'whtTypeCode']);
    expect(fe.code).toEqual(['ต้องระบุรหัส']);
  });
  it('at least one usage is required', async () => {
    const r = await call('POST', '/records/item', { ...valid, usageSales: false, usagePurchase: false });
    expect(r.status).toBe(422);
    expect((await r.json()).fieldErrors.usageSales).toEqual(['ต้องเลือกอย่างน้อยหนึ่งการใช้งาน']);
  });
  it('a negative or non-numeric price is refused; a blank price is 0.00', async () => {
    expect((await call('POST', '/records/item', { ...valid, unitPrice: '-1' })).status).toBe(422);
    expect((await call('POST', '/records/item', { ...valid, unitPrice: 'abc' })).status).toBe(422);
    expect(((await (await call('POST', '/records/item', { ...valid, unitPrice: undefined })).json()) as RecordRow).unitPrice).toBe('0.00');
  });
  it('the code is unique within the company and free in the other company', async () => {
    const dup = await call('POST', '/records/item', { ...valid, code: 'SV-01' });
    expect((await dup.json()).fieldErrors.code).toEqual(['รหัสนี้ใช้แล้ว']);
    as('accountant', 'nonvat');
    expect((await call('POST', '/records/item', { ...valid, taxCode: undefined, code: 'GD-01' })).status).toBe(422); // the non-VAT company has its own GD-01
    expect((await call('POST', '/records/item', { ...valid, taxCode: undefined, code: 'X-01' })).status).toBe(201);
    as('accountant', 'vat');
    expect((await call('POST', '/records/item', valid)).status).toBe(201); // X-01 is free in the VAT company
  });
  it('a good carries no WHT type', async () => {
    const made = (await (await call('POST', '/records/item', { ...valid, kind: 'good', code: 'G-1' })).json()) as RecordRow;
    expect(made.whtTypeCode).toBeUndefined();
    expect(loadState().items.find((i) => i.id === made.id)).not.toHaveProperty('whtTypeCode');
  });
  it('the expense category belongs to purchase items only: cleared when purchase usage is off', async () => {
    const sale = (await (await call('POST', '/records/item', { ...valid, usageSales: true, usagePurchase: false, expenseCategory: 'rent' })).json()) as RecordRow;
    expect(sale.expenseCategory).toBeUndefined();
    const buy = (await (await call('POST', '/records/item', { ...valid, code: 'X-02', usagePurchase: true, expenseCategory: 'rent' })).json()) as RecordRow;
    expect(buy).toMatchObject({ expenseCategory: 'rent', usage: 'both' });
  });
  it('non-VAT company: taxCode is ignored on save and stored EX, on create and on update', async () => {
    as('accountant', 'nonvat');
    const made = (await (await call('POST', '/records/item', { ...valid, taxCode: 'S7', code: 'N-1' })).json()) as RecordRow;
    expect(made.taxCode).toBe('EX');
    expect(loadState().items.find((i) => i.id === made.id)!.taxCode).toBe('EX');
    expect((await call('POST', '/records/item', { ...valid, taxCode: 'not-a-code', code: 'N-2' })).status).toBe(201); // ignored, not validated
    expect(((await (await call('PUT', `/records/item/${made.id}`, { ...made, taxCode: 'Z0', version: made.version })).json()) as RecordRow).taxCode).toBe('EX');
  });
  it('VAT company: an absent taxCode defaults to S7', async () => {
    expect(((await (await call('POST', '/records/item', { ...valid, taxCode: undefined })).json()) as RecordRow).taxCode).toBe('S7');
  });
  it('an item used on a document keeps its code; the rest stays editable', async () => {
    const id = usedLine().line.itemId!;
    const used = await row(id);
    expect(used.inUse).toBe(true);
    const r = await call('PUT', `/records/item/${id}`, { ...used, code: 'CHANGED', version: used.version });
    expect(r.status).toBe(422);
    expect((await r.json()).fieldErrors.code).toEqual(['รหัสแก้ไม่ได้หลังจากใช้ในเอกสารแล้ว']);
    expect((await call('PUT', `/records/item/${id}`, { ...used, name: 'ชื่อใหม่', version: used.version })).status).toBe(200);
    expect((await row('EXP-04')).inUse).toBe(false);
  });
  it('deactivating a used item hides it from type-ahead; the old document keeps its line', async () => {
    const { doc, line } = usedLine();
    const it = await row(line.itemId!);
    expect((await call('POST', `/records/item/${it.id}/active`, { active: false, version: it.version })).status).toBe(200);
    expect((await items()).some((i) => i.id === it.id)).toBe(false);
    const got = await (await call('GET', `/docs/TI/${doc.id}`)).json();
    expect(got.lines.find((l: { id: string }) => l.id === line.id)).toMatchObject({ itemId: it.id, description: line.description, unitPrice: line.unitPrice });
  });
  it('a usage change never touches documents: the line whose item no longer matches still renders', async () => {
    const { doc, line } = usedLine();
    const it = await row(line.itemId!);
    expect((await call('PUT', `/records/item/${it.id}`, { ...it, usageSales: false, usagePurchase: true, version: it.version })).status).toBe(200);
    expect((await items('usage=sales&limit=200')).some((i) => i.id === it.id)).toBe(false);
    const got = await (await call('GET', `/docs/TI/${doc.id}`)).json();
    expect(got.lines.find((l: { id: string }) => l.id === line.id)).toMatchObject({ itemId: it.id, description: line.description });
  });
  it('a stale version is a 409', async () => {
    const r = await row('SV-03');
    expect((await call('PUT', '/records/item/SV-03', { ...r, name: 'ก', version: r.version + 5 })).status).toBe(409);
  });
});

describe('item permissions and isolation', () => {
  it('operator may read but not manage items; accountant and admin may manage', async () => {
    as('operator');
    expect((await call('GET', '/records/item')).status).toBe(200);
    const w = await call('POST', '/records/item', valid);
    expect(w.status).toBe(403);
    expect((await w.json()).detail).toContain('item.manage');
    expect((await call('PUT', '/records/item/SV-01', { ...valid, version: 1 })).status).toBe(403);
    as('admin');
    expect((await call('POST', '/records/item', valid)).status).toBe(201);
    as('accountant');
    expect((await call('POST', '/records/item', { ...valid, code: 'X-09' })).status).toBe(201);
  });
  it('writes on the other company item id are 404 and change nothing', async () => {
    as('accountant', 'nonvat');
    const before = JSON.stringify(loadState().items);
    const put = await call('PUT', '/records/item/SV-01', { ...valid, version: 1 });
    const act = await call('POST', '/records/item/SV-01/active', { active: false, version: 1 });
    expect([put.status, act.status]).toEqual([404, 404]);
    expect(JSON.stringify(loadState().items)).toBe(before);
    expect(loadState().audit.some((a) => a.target === 'SV-01')).toBe(false);
  });
  it('client-supplied id, companyId, version and active are not mass-assigned', async () => {
    const made = (await (await call('POST', '/records/item', { ...valid, id: 'SV-01', companyId: 'co-nonvat', version: 99, active: false })).json()) as RecordRow;
    expect(made).toMatchObject({ active: true, version: 1 });
    expect(made.id).not.toBe('SV-01');
    expect(loadState().items.find((i) => i.id === made.id)!.companyId).toBe('co-vat');
    expect(loadState().items.filter((i) => i.id === 'SV-01')).toHaveLength(1);
    const before = await row('SV-01');
    expect((await call('PUT', '/records/item/SV-01', { ...before, id: made.id, companyId: 'co-nonvat', active: false, version: before.version })).status).toBe(200);
    const after = loadState().items.find((i) => i.id === 'SV-01')!;
    expect([after.companyId, after.active !== false]).toEqual(['co-vat', true]);
  });
  it('create writes one audit entry and is idempotent on the key', async () => {
    const h = { 'content-type': 'application/json', 'Idempotency-Key': 'k-1' };
    const post = () => fetch('http://localhost/bff/v1/records/item', { method: 'POST', headers: h, body: JSON.stringify(valid) });
    const [a, b] = [await (await post()).json(), await (await post()).json()];
    expect(a.id).toBe(b.id);
    expect(loadState().items.filter((i) => i.code === 'X-01')).toHaveLength(1);
    expect(loadState().audit.filter((x) => x.command === 'record.item.create')).toHaveLength(1);
  });
});
