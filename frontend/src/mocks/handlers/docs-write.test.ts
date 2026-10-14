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
const partyId = () => loadState().parties.find((p) => p.companyId === 'co-vat' && p.kind === 'customer' && p.vatRegistered && p.taxId)!.id;
const body = () => ({ header: { partyId: partyId(), documentDate: '2026-10-14' },
  lines: [{ id: 'l1', description: 'ออกแบบ', qty: '1', unit: 'งาน', unitPrice: '1000.00', taxCode: 'S7' }] });

describe('write handlers', () => {
  it('create (idempotent) -> issue -> ledger -> cancel, persisted across calls', async () => {
    const a = await call('POST', '/docs/TI', body(), { 'Idempotency-Key': 'abc' });
    expect(a.status).toBe(201);
    const d = await a.json();
    expect((await (await call('POST', '/docs/TI', body(), { 'Idempotency-Key': 'abc' })).json()).id).toBe(d.id);
    const issued = await (await call('POST', `/docs/TI/${d.id}/issue`, { version: d.version })).json();
    expect(issued.number).toMatch(/^TI-202610-/);
    const ledger = await (await call('GET', `/docs/TI/${d.id}/ledger`)).json();
    expect(ledger.entries[0].lines.map((l: { accountCode: string }) => l.accountCode)).toEqual(['1130', '4100', '2151']);
    const c = await call('POST', `/docs/TI/${d.id}/cancel`, { version: issued.version, reasonCode: 'OTHER', reasonText: 'ทดสอบ' });
    expect((await c.json()).status).toBe('cancelled');
    const chain = await (await call('GET', `/docs/TI/${d.id}/chain`)).json();
    expect(chain.nodes).toHaveLength(1);
  });
  it('stale version -> 409 problem+json; operator cannot cancel -> 403', async () => {
    const d = await (await call('POST', '/docs/TI', body())).json();
    const stale = await call('POST', `/docs/TI/${d.id}/issue`, { version: 99 });
    expect(stale.status).toBe(409);
    expect((await stale.json()).code).toBe('doc.version_conflict');
    setSettings({ role: 'operator' });
    expect((await call('POST', `/docs/TI/${d.id}/cancel`, { version: 1, reasonCode: 'OTHER', reasonText: 'x' })).status).toBe(403);
  });
  it('/corrections refuses a plan from another company (404) and a downgraded role (403)', async () => {
    const ti = loadState().docs.find((x) => x.type === 'TI' && x.status === 'settled' && !x.locks.length)!;
    const p1 = await (await call('POST', `/docs/TI/${ti.id}/correction-plan`, { header: { ...ti.header, notes: 'อ้างอิง PO' }, lines: ti.lines })).json();
    setSettings({ companyKey: 'nonvat' });
    expect((await call('POST', '/corrections', { planId: p1.planId, planHash: p1.planHash })).status).toBe(404);
    setSettings({ companyKey: 'vat', role: 'operator' });
    expect((await call('POST', '/corrections', { planId: p1.planId, planHash: p1.planHash })).status).toBe(403);
    expect(loadState().docs.find((x) => x.id === ti.id)!.header.notes).toBe(ti.header.notes); // nothing executed
  });
  it('correction plan then execute through /corrections', async () => {
    const ti = loadState().docs.find((x) => x.type === 'TI' && x.status === 'settled' && !x.locks.length)!;
    const plan = await (await call('POST', `/docs/TI/${ti.id}/correction-plan`, { header: { ...ti.header, notes: 'อ้างอิง PO' }, lines: ti.lines })).json();
    expect(plan.steps.map((s: { action: string }) => s.action)).toEqual(['revise']);
    const r = await call('POST', '/corrections', { planId: plan.planId, planHash: plan.planHash });
    expect(r.status).toBe(200);
    expect(loadState().docs.find((x) => x.id === ti.id)!.header.notes).toBe('อ้างอิง PO');
    expect((await call('POST', '/corrections', { planId: plan.planId, planHash: plan.planHash })).status).toBe(404); // single use
  });
});

describe('paper endpoint', () => {
  const paper = async (id: string, q = '') => (await call('GET', `/docs/TI/${id}/paper${q}`)).json();
  const issuedTi = () => loadState().docs.find((x) => x.type === 'TI' && x.companyId === 'co-vat' && x.status === 'issued' && x.party?.taxId)!;
  it('serves the document, company and party snapshots with the stored totals', async () => {
    const d = issuedTi();
    const p = await paper(d.id);
    expect(p).toMatchObject({ titleTh: 'ใบกำกับภาษี', titleEn: 'TAX INVOICE', copyLabel: 'ต้นฉบับ', number: d.number, documentDate: d.header.documentDate });
    expect(p.seller).toMatchObject({ taxId: '0105569012345', branchLabel: 'สำนักงานใหญ่ (00000)' });
    expect(p.buyer).toMatchObject({ name: d.party!.name, taxId: d.party!.taxId });
    expect(p.totals).toEqual(d.totals);
    expect(p.lines).toHaveLength(d.lines.length);
    expect(p.lines[0]).toMatchObject({ no: 1, description: d.lines[0].description, unitPrice: d.lines[0].unitPrice });
    expect(p.signatures).toEqual(['ผู้รับสินค้า/บริการ', 'ผู้รับเงิน', 'ผู้มีอำนาจลงนาม']);
    expect(p.voidMark).toBeUndefined();
    expect(p.replacementNote).toBeUndefined();
  });
  it('?copy=1 prints สำเนา', async () => {
    expect((await paper(issuedTi().id, '?copy=1')).copyLabel).toBe('สำเนา');
  });
  it('a replaced original is stamped and names its replacement; the replacement carries the I9 wording', async () => {
    const old = loadState().docs.find((x) => x.type === 'TI' && x.status === 'replaced' && x.replacedById)!;
    const nw = loadState().docs.find((x) => x.id === old.replacedById)!;
    const po = await paper(old.id);
    expect(po.voidMark.label).toBe('ถูกแทนที่');
    expect(po.voidMark.note).toContain(nw.number);
    const pn = await paper(nw.id);
    expect(pn.replacementNote).toContain('ยกเลิกและออกแทนฉบับเดิม เลขที่ ' + old.number);
    expect(pn.replacementNote).toMatch(/ลงวันที่ \d+ \S+ \d{4}$/);
    expect(pn.voidMark).toBeUndefined();
  });
  it('a cancelled document is stamped ยกเลิก', async () => {
    const d = await (await call('POST', '/docs/TI', body())).json();
    const issued = await (await call('POST', `/docs/TI/${d.id}/issue`, { version: d.version })).json();
    await call('POST', `/docs/TI/${d.id}/cancel`, { version: issued.version, reasonCode: 'OTHER', reasonText: 'ทดสอบ' });
    expect((await paper(d.id)).voidMark.label).toBe('ยกเลิก');
  });
  it('a document of another company is 404', async () => {
    const id = issuedTi().id;
    setSettings({ companyKey: 'nonvat' });
    expect((await call('GET', `/docs/TI/${id}/paper`)).status).toBe(404);
  });
});
