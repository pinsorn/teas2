import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { RecordRow } from '@/domain/records';
import { tinCheckDigit } from '@/domain/tin';
import { PARTY_FIXTURES } from '../fixtures/parties';
import { setSettings } from '../settings';
import { loadState, resetState } from '../store';
import { testServer } from '../test-server';
import { RECORD_IMPLS } from './registry';

beforeAll(() => testServer.listen({ onUnhandledFrame: 'error' }));
afterEach(() => testServer.resetHandlers());
afterAll(() => testServer.close());
beforeEach(() => { localStorage.clear(); resetState(); setSettings({ companyKey: 'vat', role: 'accountant', screenState: 'normal' }); });

const TIN = `010550000000${tinCheckDigit('010550000000')}`;
const BAD_TIN = `010550000000${(tinCheckDigit('010550000000') + 1) % 10}`;
const BAD_TIN_MSG = 'เลขประจำตัวผู้เสียภาษีไม่ถูกต้อง (ตรวจสอบหลักสุดท้าย)';
const valid = { entityKind: 'juristic', code: 'C99', name: 'บริษัท ทดสอบระบบ จำกัด', taxId: TIN, branchCode: '00000', vatRegistered: false, paymentTermDays: 30 };
const customer = RECORD_IMPLS.customer!;
const vendor = RECORD_IMPLS.vendor!;
const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(`http://localhost/bff/v1${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
const row = async (id: string) => (await (await call('GET', `/records/customer/${id}`)).json()) as RecordRow;

describe('party record impls (mock validation, Thai)', () => {
  it('customer: bad TIN checksum → fieldErrors.taxId', () => {
    const st = loadState();
    expect(customer.validate({ ...valid, taxId: BAD_TIN }, st, 'co-vat')).toEqual({ taxId: [BAD_TIN_MSG] });
    expect(customer.validate({ ...valid, taxId: '123' }, st, 'co-vat').taxId).toEqual([BAD_TIN_MSG]);
    expect(customer.validate(valid, st, 'co-vat')).toEqual({}); // the same record with a good TIN is clean
  });
  it('customer: VAT-registered without address → fieldErrors.address (I3)', () => {
    const st = loadState();
    expect(customer.validate({ ...valid, vatRegistered: true }, st, 'co-vat').address).toEqual(['ผู้ซื้อที่จดทะเบียน VAT ต้องมีที่อยู่ตามทะเบียน']);
    expect(customer.validate({ ...valid, vatRegistered: true, address: '12 ถนนสุขุมวิท กรุงเทพมหานคร' }, st, 'co-vat')).toEqual({});
    expect(customer.validate({ ...valid, vatRegistered: true, address: '   ' }, st, 'co-vat').address).toHaveLength(1); // blank is not an address
  });
  it('customer: a TIN needs a 5-digit branch; a juristic or VAT customer needs a TIN', () => {
    const st = loadState();
    expect(customer.validate({ ...valid, branchCode: '0' }, st, 'co-vat').branchCode).toEqual(['ต้องระบุสาขา 5 หลัก']);
    expect(customer.validate({ ...valid, taxId: undefined }, st, 'co-vat').taxId).toHaveLength(1); // juristic
    expect(customer.validate({ ...valid, entityKind: 'individual', taxId: undefined, branchCode: undefined }, st, 'co-vat')).toEqual({});
  });
  it('customer: code is unique per kind within a company; the same code is allowed in the other company and for a vendor', () => {
    const st = loadState();
    const existing = st.parties.find((p) => p.id === PARTY_FIXTURES.customerVat)!; // co-vat C01
    expect(customer.validate({ ...valid, code: existing.code }, st, 'co-vat').code).toEqual(['รหัสนี้ใช้แล้ว']);
    const made = customer.create(st, 'co-vat', valid);
    expect(customer.validate({ ...valid }, st, 'co-vat').code).toEqual(['รหัสนี้ใช้แล้ว']);
    expect(customer.validate({ ...valid }, st, 'co-vat', made.id)).not.toHaveProperty('code'); // a record never collides with itself
    expect(customer.validate({ ...valid }, st, 'co-nonvat')).toEqual({});
    expect(vendor.validate({ ...valid }, st, 'co-vat')).not.toHaveProperty('code'); // customers and vendors are separate lists: a vendor may reuse C99
  });
  it('customer: code is read-only once the party is used on a document', async () => {
    const used = await row(PARTY_FIXTURES.customerVat);
    expect(used.inUse).toBe(true);
    const r = await call('PUT', `/records/customer/${used.id}`, { ...used, code: 'C77', version: used.version });
    expect(r.status).toBe(422);
    expect((await r.json()).fieldErrors.code).toEqual(['รหัสแก้ไม่ได้หลังจากใช้ในเอกสารแล้ว']);
    expect((await call('PUT', `/records/customer/${used.id}`, { ...used, name: 'ชื่อใหม่', version: used.version })).status).toBe(200); // the rest stays editable
    const unused = await row(PARTY_FIXTURES.customerInactive);
    expect(unused.inUse).toBe(false);
    expect((await call('PUT', `/records/customer/${unused.id}`, { ...unused, code: 'C78', version: unused.version })).status).toBe(200);
  });
  it('vendor foreign: vatDRegistered allowed; taxId optional', () => {
    const st = loadState();
    const foreign = { entityKind: 'foreign', code: 'V99', name: 'Acme Cloud Ltd.', vatRegistered: false, vatDRegistered: true, paymentTermDays: 30 };
    expect(vendor.validate(foreign, st, 'co-vat')).toEqual({});
    expect(vendor.rows(st, 'co-vat').find((r) => r.id === PARTY_FIXTURES.vendorForeign)).toMatchObject({ entityKind: 'foreign', vatDRegistered: false });
    expect(vendor.rows(st, 'co-vat').find((r) => r.id === 'pv-01')).not.toHaveProperty('vatDRegistered', true);
    const made = vendor.create(st, 'co-vat', foreign);
    expect(made).toMatchObject({ vatDRegistered: true, entityKind: 'foreign' });
    expect(made.taxId).toBeUndefined();
    expect(vendor.validate({ ...foreign, entityKind: 'juristic' }, st, 'co-vat').taxId).toHaveLength(1); // a company vendor still needs one
  });
  it('vendor: remittance details round-trip through the flat fields', () => {
    const st = loadState();
    const made = vendor.create(st, 'co-vat', { ...valid, code: 'V98', bankName: 'ธนาคารตัวอย่าง', bankAccountNo: '111-2-33333-4', bankAccountName: 'บริษัท ทดสอบระบบ จำกัด' });
    expect(made).toMatchObject({ bankName: 'ธนาคารตัวอย่าง', bankAccountNo: '111-2-33333-4', bankAccountName: 'บริษัท ทดสอบระบบ จำกัด' });
    expect(vendor.rows(st, 'co-vat').find((r) => r.id === 'pv-01')).toMatchObject({ bankName: expect.any(String), bankAccountNo: expect.any(String) }); // fixtures
  });
});

describe('/records handlers', () => {
  it('update with a stale version → 409 record.version_conflict, and the right version wins', async () => {
    const r0 = await row(PARTY_FIXTURES.customerVat);
    const ok = await call('PUT', `/records/customer/${r0.id}`, { ...r0, nameEn: 'Nava Trading', version: r0.version });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as RecordRow).version).toBe(r0.version + 1);
    const stale = await call('PUT', `/records/customer/${r0.id}`, { ...r0, nameEn: 'Late', version: r0.version });
    expect(stale.status).toBe(409);
    expect((await stale.json()).code).toBe('record.version_conflict');
    expect((await row(r0.id)).nameEn).toBe('Nava Trading'); // the stale write changed nothing
    const staleActive = await call('POST', `/records/customer/${r0.id}/active`, { active: false, version: r0.version });
    expect(staleActive.status).toBe(409);
  });
  it('every write appends an audit entry with before/after', async () => {
    const before = loadState().audit.length;
    const created = (await (await call('POST', '/records/customer', valid, { 'Idempotency-Key': 'k1' })).json()) as RecordRow;
    const upd = (await (await call('PUT', `/records/customer/${created.id}`, { ...created, name: 'ชื่อแก้ไข', version: created.version })).json()) as RecordRow;
    const off = (await (await call('POST', `/records/customer/${created.id}/active`, { active: false, version: upd.version })).json()) as RecordRow;
    await call('POST', `/records/customer/${created.id}/active`, { active: true, version: off.version });
    const audit = loadState().audit.slice(before);
    expect(audit.map((a) => [a.command, a.target, a.result])).toEqual([
      ['record.customer.create', created.id, 'ok'], ['record.customer.update', created.id, 'ok'],
      ['record.customer.deactivate', created.id, 'ok'], ['record.customer.activate', created.id, 'ok'],
    ]);
    expect(audit[0].before).toBeUndefined();
    expect(audit[0].after).toMatchObject({ code: 'C99', name: 'บริษัท ทดสอบระบบ จำกัด' });
    expect(audit[1].before).toMatchObject({ name: 'บริษัท ทดสอบระบบ จำกัด' });
    expect(audit[1].after).toMatchObject({ name: 'ชื่อแก้ไข' });
    expect([(audit[2].before as RecordRow).active, (audit[2].after as RecordRow).active]).toEqual([true, false]);
    expect(audit.every((a) => a.actor.kind === 'user' && a.companyId === 'co-vat')).toBe(true);
  });
  it('writes on the other company id are 404 and change nothing', async () => {
    setSettings({ companyKey: 'nonvat' });
    const before = JSON.stringify(loadState().parties);
    const put = await call('PUT', '/records/customer/pc-01', { ...valid, version: 1 });
    const act = await call('POST', '/records/customer/pc-01/active', { active: false, version: 1 });
    expect([put.status, act.status]).toEqual([404, 404]);
    expect((await put.json()).code).toBe('record.not_found');
    expect(JSON.stringify(loadState().parties)).toBe(before);
    expect(loadState().audit.some((a) => a.target === 'pc-01')).toBe(false);
  });
  it('client-supplied active, id, companyId, kind and version are not mass-assigned (create ignores them; update keeps its own)', async () => {
    const evil = { active: false, id: 'pc-01', companyId: 'co-nonvat', kind: 'vendor', version: 99, inUse: true };
    const made = (await (await call('POST', '/records/customer', { ...valid, ...evil })).json()) as RecordRow;
    expect(made).toMatchObject({ active: true, version: 1, inUse: false });
    expect(made.id).not.toBe('pc-01');
    const mine = loadState().parties.find((p) => p.id === made.id)!;
    expect([mine.companyId, mine.kind, mine.active]).toEqual(['co-vat', 'customer', undefined]);
    expect(loadState().parties.filter((p) => p.id === 'pc-01')).toHaveLength(1);
    const before = await row('pc-01');
    const upd = await call('PUT', '/records/customer/pc-01', { ...before, active: false, id: made.id, companyId: 'co-nonvat', kind: 'vendor', version: before.version });
    expect(upd.status).toBe(200);
    const after = loadState().parties.find((p) => p.id === 'pc-01')!;
    expect([after.companyId, after.kind, after.active !== false, after.version]).toEqual(['co-vat', 'customer', true, before.version + 1]);
    expect(loadState().parties.find((p) => p.id === made.id)!.name).toBe(valid.name); // the other record was not touched
  });
  it('a rejected write leaves no party and no audit entry; the same Idempotency-Key creates once', async () => {
    const a0 = loadState().audit.length;
    const bad = await call('POST', '/records/customer', { ...valid, taxId: BAD_TIN });
    expect(bad.status).toBe(422);
    const b = await bad.json();
    expect([b.code, b.fieldErrors.taxId]).toEqual(['record.invalid', [BAD_TIN_MSG]]);
    expect(loadState().audit).toHaveLength(a0);
    const one = (await (await call('POST', '/records/customer', valid, { 'Idempotency-Key': 'same' })).json()) as RecordRow;
    const two = (await (await call('POST', '/records/customer', valid, { 'Idempotency-Key': 'same' })).json()) as RecordRow;
    expect(two.id).toBe(one.id);
    expect(loadState().parties.filter((p) => p.code === 'C99' && p.companyId === 'co-vat')).toHaveLength(1);
  });
  it('list: search, active filter (default active), paging; the other company is invisible', async () => {
    const list = async (q: string) => (await (await call('GET', `/records/customer${q}`)).json()) as { items: RecordRow[]; total: number; nextCursor?: string };
    const active = await list('');
    expect(active.items.every((r) => r.active)).toBe(true);
    expect(active.items.map((r) => r.id)).not.toContain(PARTY_FIXTURES.customerInactive);
    expect((await list('?active=false')).items.map((r) => r.id)).toEqual([PARTY_FIXTURES.customerInactive]);
    expect((await list('?active=all')).items.map((r) => r.id)).toContain(PARTY_FIXTURES.customerInactive);
    expect((await list('?q=นาวา')).items.map((r) => r.id)).toEqual(['pc-01']);
    const p1 = await list('?limit=5');
    expect([p1.items.length, p1.total, !!p1.nextCursor]).toEqual([5, 12, true]);
    expect((await list(`?limit=5&cursor=${p1.nextCursor}`)).items.map((r) => r.id)).not.toContain(p1.items[0].id);
    setSettings({ companyKey: 'nonvat' });
    expect((await list('?active=all')).items.every((r) => r.id.startsWith('nc-'))).toBe(true);
    expect((await call('GET', '/records/customer/pc-01')).status).toBe(404); // another company's record
  });
  it('an inactive party is not offered by the document party picker, and search links to the master pages', async () => {
    const picked = (await (await call('GET', '/parties?kind=customer&limit=200')).json()) as { items: { id: string }[] };
    expect(picked.items.map((p) => p.id)).toContain('pc-01');
    expect(picked.items.map((p) => p.id)).not.toContain(PARTY_FIXTURES.customerInactive);
    const hits = (await (await call('GET', '/search?q=นาวา')).json()) as { items: { kind: string; href?: string }[] };
    expect(hits.items.find((h) => h.kind === 'party')?.href).toBe('/master/customers/pc-01');
  });
  it('404 for an unknown kind and for a kind with no implementation; 403 names the manage permission', async () => {
    const unknown = await call('GET', '/records/nonsense');
    expect([unknown.status, (await unknown.json()).code]).toEqual([404, 'record.kind_unknown']);
    expect((await call('GET', '/records/bank-account')).status).toBe(404); // known kind, not built yet
    setSettings({ role: 'admin' });
    expect((await call('GET', '/records/customer')).status).toBe(200); // party.read
    const w = await call('POST', '/records/customer', valid);
    expect(w.status).toBe(403);
    expect((await w.json()).detail).toContain('party.manage');
    expect(loadState().parties.some((p) => p.code === 'C99')).toBe(false);
  });
  it('screen states apply (error → 500, forbidden → 403, empty list)', async () => {
    setSettings({ screenState: 'error' });
    expect((await call('GET', '/records/customer')).status).toBe(500);
    setSettings({ screenState: 'forbidden' });
    expect((await call('GET', '/records/customer')).status).toBe(403);
    setSettings({ screenState: 'empty' });
    expect(await (await call('GET', '/records/customer')).json()).toEqual({ items: [] });
  });
  it('deactivating a party that documents use is allowed (documents keep their snapshot); a refusal is only for rules that demand it', async () => {
    const used = await row(PARTY_FIXTURES.customerVat);
    const r = await call('POST', `/records/customer/${used.id}/active`, { active: false, version: used.version });
    expect(r.status).toBe(200);
    expect(((await r.json()) as RecordRow).active).toBe(false);
    const st = loadState();
    expect(st.docs.filter((d) => d.header.partyId === used.id).every((d) => d.party?.name)).toBe(true);
    vendor.canDeactivate = () => 'ผังบัญชีผูกกับกฎการลงบัญชี'; // a rule that demands refusal
    try {
      const v = await (await call('GET', '/records/vendor?limit=1')).json();
      const refused = await call('POST', `/records/vendor/${v.items[0].id}/active`, { active: false, version: v.items[0].version });
      expect(refused.status).toBe(409);
      const body = await refused.json();
      expect([body.code, body.detail]).toEqual(['record.in_use', 'ผังบัญชีผูกกับกฎการลงบัญชี']);
    } finally { delete vendor.canDeactivate; }
  });
});

describe('GET /docs/by-party/:partyId', () => {
  it('lists the party documents of every readable type, newest first, with the server total', async () => {
    const r = await call('GET', '/docs/by-party/pc-01');
    expect(r.status).toBe(200);
    const body = (await r.json()) as { items: { id: string; type: string; documentDate: string }[]; total: number };
    const st = loadState();
    const mine = st.docs.filter((d) => d.header.partyId === 'pc-01' && ['TI', 'RC', 'QT', 'SO', 'DO', 'CN', 'DN', 'IV'].includes(d.type));
    expect(body.total).toBe(mine.length);
    expect(body.items.length).toBeGreaterThan(2);
    expect(body.items.map((i) => i.documentDate)).toEqual([...body.items.map((i) => i.documentDate)].sort().reverse());
    expect(new Set(body.items.map((i) => i.type)).size).toBeGreaterThan(1); // across types, not just TI
  });
  it('skips types the role cannot read instead of failing; unknown party → 404', async () => {
    setSettings({ role: 'admin' });
    const r = await call('GET', '/docs/by-party/pc-01');
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ items: [], total: 0 });
    setSettings({ role: 'accountant' });
    expect((await call('GET', '/docs/by-party/nope')).status).toBe(404);
    setSettings({ companyKey: 'nonvat' });
    expect((await call('GET', '/docs/by-party/pc-01')).status).toBe(404); // another company's party
  });
});
