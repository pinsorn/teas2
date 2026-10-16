import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PAPER_BUILDERS } from '../engine/paper';
import { setSettings } from '../settings';
import { PERMISSIONS_BY_ROLE } from '../permissions';
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
    const ti = loadState().docs.find((x) => x.type === 'TI' && x.status === 'settled' && !x.locks.some((l) => l.kind === 'filing'))!;
    const p1 = await (await call('POST', `/docs/TI/${ti.id}/correction-plan`, { header: { ...ti.header, notes: 'อ้างอิง PO' }, lines: ti.lines })).json();
    setSettings({ companyKey: 'nonvat' });
    expect((await call('POST', '/corrections', { planId: p1.planId, planHash: p1.planHash })).status).toBe(404);
    setSettings({ companyKey: 'vat', role: 'operator' });
    expect((await call('POST', '/corrections', { planId: p1.planId, planHash: p1.planHash })).status).toBe(403);
    expect(loadState().docs.find((x) => x.id === ti.id)!.header.notes).toBe(ti.header.notes); // nothing executed
  });
  it('correction plan then execute through /corrections', async () => {
    const ti = loadState().docs.find((x) => x.type === 'TI' && x.status === 'settled' && !x.locks.some((l) => l.kind === 'filing'))!;
    const plan = await (await call('POST', `/docs/TI/${ti.id}/correction-plan`, { header: { ...ti.header, notes: 'อ้างอิง PO' }, lines: ti.lines })).json();
    expect(plan.steps.map((s: { action: string }) => s.action)).toEqual(['revise']);
    const r = await call('POST', '/corrections', { planId: plan.planId, planHash: plan.planHash });
    expect(r.status).toBe(200);
    expect(loadState().docs.find((x) => x.id === ti.id)!.header.notes).toBe('อ้างอิง PO');
    expect((await call('POST', '/corrections', { planId: plan.planId, planHash: plan.planHash })).status).toBe(404); // single use
  });
});

describe('I6 correction-plan needs the create permission', () => {
  it('a role that can read but not create gets 403 and no plan is stored', async () => {
    const ti = loadState().docs.find((x) => x.type === 'TI' && x.status === 'issued')!;
    const saved = PERMISSIONS_BY_ROLE.operator;
    PERMISSIONS_BY_ROLE.operator = saved.filter((p) => p !== 'doc.TI.create');
    try {
      setSettings({ role: 'operator' });
      const r = await call('POST', `/docs/TI/${ti.id}/correction-plan`, { header: { ...ti.header, notes: 'x' }, lines: ti.lines });
      expect(r.status).toBe(403);
      expect(Object.keys(loadState().plans ?? {})).toEqual([]);
    } finally { PERMISSIONS_BY_ROLE.operator = saved; }
  });
});

describe('marks and remaining endpoints', () => {
  const qt = (company = 'co-vat') => loadState().docs.find((x) => x.type === 'QT' && x.companyId === company && x.status === 'issued' && !x.marks)!;
  const withoutPerm = async (role: 'operator' | 'accountant', perm: string, fn: () => Promise<void>) => {
    const saved = PERMISSIONS_BY_ROLE[role];
    PERMISSIONS_BY_ROLE[role] = saved.filter((p) => p !== perm);
    try { setSettings({ role }); await fn(); } finally { PERMISSIONS_BY_ROLE[role] = saved; }
  };
  it('POST /marks: 403 naming doc.QT.issue without it, and nothing is written', async () => {
    const q = qt();
    await withoutPerm('accountant', 'doc.QT.issue', async () => {
      const r = await call('POST', `/docs/QT/${q.id}/marks`, { mark: 'accepted', version: q.version });
      expect(r.status).toBe(403);
      expect(JSON.stringify(await r.json())).toContain('doc.QT.issue');
    });
    expect(loadState().docs.find((x) => x.id === q.id)!.marks).toBeUndefined();
  });
  it('GET /remaining: 403 naming doc.QT.read without it', async () => {
    const q = qt();
    await withoutPerm('accountant', 'doc.QT.read', async () => {
      const r = await call('GET', `/docs/QT/${q.id}/remaining`);
      expect(r.status).toBe(403);
      expect(JSON.stringify(await r.json())).toContain('doc.QT.read');
    });
  });
  it('a document of another company is 404 on both endpoints', async () => {
    const other = qt('co-vat');
    setSettings({ companyKey: 'nonvat', role: 'operator' });
    expect((await call('POST', `/docs/QT/${other.id}/marks`, { mark: 'accepted', version: other.version })).status).toBe(404);
    expect((await call('GET', `/docs/QT/${other.id}/remaining`)).status).toBe(404);
    expect(loadState().docs.find((x) => x.id === other.id)!.marks).toBeUndefined();
  });
  it('POST /marks: a missing version is 422 doc.version_required, a stale one 409 doc.version_conflict', async () => {
    const q = qt();
    const none = await call('POST', `/docs/QT/${q.id}/marks`, { mark: 'accepted' });
    expect([none.status, (await none.json()).code]).toEqual([422, 'doc.version_required']);
    const stale = await call('POST', `/docs/QT/${q.id}/marks`, { mark: 'accepted', version: q.version + 3 });
    expect([stale.status, (await stale.json()).code]).toEqual([409, 'doc.version_conflict']);
  });
  it('POST /marks: an unknown or foreign mark is 422 mark.not_allowed; a reject without reason 422', async () => {
    const q = qt();
    for (const mark of ['bogus', 'delivered', 'closed']) {
      const r = await call('POST', `/docs/QT/${q.id}/marks`, { mark, version: q.version });
      expect([r.status, (await r.json()).code]).toEqual([422, 'mark.not_allowed']);
    }
    const r = await call('POST', `/docs/QT/${q.id}/marks`, { mark: 'rejected', version: q.version });
    expect([r.status, (await r.json()).code]).toEqual([422, 'mark.reason_required']);
  });
});

describe('close-remainder endpoint', () => {
  const so = () => loadState().docs.find((x) => x.id === 'so-part')!;
  const post = (id: string, b: unknown) => call('POST', `/docs/SO/${id}/close-remainder`, b);
  it('403 naming doc.SO.issue without it, and nothing is written', async () => {
    const d = so();
    const saved = PERMISSIONS_BY_ROLE.accountant;
    PERMISSIONS_BY_ROLE.accountant = saved.filter((p) => p !== 'doc.SO.issue');
    try {
      const r = await post(d.id, { version: d.version, reason: 'x' });
      expect(r.status).toBe(403);
      expect(JSON.stringify(await r.json())).toContain('doc.SO.issue');
    } finally { PERMISSIONS_BY_ROLE.accountant = saved; }
    expect(so().marks?.closed).toBeUndefined();
  });
  it('a document of another company is 404', async () => {
    const d = so();
    setSettings({ companyKey: 'nonvat', role: 'operator' });
    expect((await post(d.id, { version: d.version, reason: 'x' })).status).toBe(404);
  });
  it('missing version 422, stale 409, missing reason 422, a QT 422, then it closes and a second close is 409', async () => {
    const d = so();
    const code = async (r: Response) => [r.status, (await r.json()).code];
    expect(await code(await post(d.id, { reason: 'x' }))).toEqual([422, 'doc.version_required']);
    expect(await code(await post(d.id, { version: d.version + 4, reason: 'x' }))).toEqual([409, 'doc.version_conflict']);
    expect(await code(await post(d.id, { version: d.version, reason: '  ' }))).toEqual([422, 'mark.reason_required']);
    const qt = loadState().docs.find((x) => x.id === 'qt-acc')!;
    expect(await code(await call('POST', `/docs/QT/${qt.id}/close-remainder`, { version: qt.version, reason: 'x' }))).toEqual([422, 'mark.not_allowed']);
    const ok = await post(d.id, { version: d.version, reason: 'ลูกค้าไม่รับ' });
    expect(ok.status).toBe(200);
    expect((await ok.json()).marks.closed.reason).toBe('ลูกค้าไม่รับ');
    expect(await code(await post(d.id, { version: d.version + 1, reason: 'y' }))).toEqual([409, 'doc.already_closed']);
  });
  it('converting from a closed SO is refused by the server with the revision exit (409 doc.closed)', async () => {
    const d = loadState().docs.find((x) => x.id === 'so-closed')!;
    const r = await call('POST', `/docs/SO/${d.id}/convert`, { targetType: 'DO', lines: [{ sourceLineId: 'so-closed-l1', qty: '1' }] });
    const b = await r.json();
    expect([r.status, b.code]).toEqual([409, 'doc.closed']);
    expect(b.title).toContain('แก้ไขเอกสาร');
    expect((await (await call('GET', `/docs/SO/${d.id}/remaining`)).json()).map((l: { remaining: string }) => l.remaining)).toEqual(['0', '0']);
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
    expect(pn.documentDate).toBe(po.documentDate); // I9: the replacement keeps the original date and total
    expect(pn.totals.total).toBe(po.totals.total);
  });
  it('a cancelled document is stamped ยกเลิก', async () => {
    const d = await (await call('POST', '/docs/TI', body())).json();
    const issued = await (await call('POST', `/docs/TI/${d.id}/issue`, { version: d.version })).json();
    await call('POST', `/docs/TI/${d.id}/cancel`, { version: issued.version, reasonCode: 'OTHER', reasonText: 'ทดสอบ' });
    expect((await paper(d.id)).voidMark.label).toBe('ยกเลิก');
  });
  it('a type without a paper builder is 404 doc.paper_not_available (registry, not a TI literal)', async () => {
    const so = loadState().docs.find((x) => x.type === 'CN' && x.status === 'issued' && x.companyId === 'co-vat')!;
    const builder = PAPER_BUILDERS.CN;
    delete PAPER_BUILDERS.CN; // the registry decides, not a type literal
    try {
      const r = await call('GET', `/docs/CN/${so.id}/paper`);
      expect(r.status).toBe(404);
      expect((await r.json()).code).toBe('doc.paper_not_available');
    } finally { PAPER_BUILDERS.CN = builder; }
  });
  it('a document of another company is 404', async () => {
    const id = issuedTi().id;
    setSettings({ companyKey: 'nonvat' });
    expect((await call('GET', `/docs/TI/${id}/paper`)).status).toBe(404);
  });
  const issue = async (lines: { taxCode: string; unitPrice: string }[]) => {
    const b = body();
    b.lines = lines.map((l, i) => ({ id: 'z' + i, description: 'รายการ ' + i, qty: '1', unit: 'งาน', unitPrice: l.unitPrice, taxCode: l.taxCode })) as never;
    const d = await (await call('POST', '/docs/TI', b)).json();
    const iss = await (await call('POST', `/docs/TI/${d.id}/issue`, { version: d.version })).json();
    return { paper: await paper(iss.id), doc: iss };
  };
  it('a draft is not printable: 409 doc.not_printable', async () => {
    const d = await (await call('POST', '/docs/TI', body())).json();
    const r = await call('GET', `/docs/TI/${d.id}/paper`);
    expect(r.status).toBe(409);
    expect((await r.json()).code).toBe('doc.not_printable');
  });
  it('vatLines: all zero-rated shows no 7% line; mixed shows both with the engine VAT', async () => {
    const z = await issue([{ taxCode: 'Z0', unitPrice: '1000.00' }]);
    expect(z.paper.vatLines.map((l: { label: string }) => l.label).join('|')).not.toContain('7%');
    expect(z.paper.vatLines).toContainEqual({ label: 'ยอดขายอัตราร้อยละ 0', amount: '1000.00' });
    expect(z.paper.vatLines.at(-1)).toEqual({ label: 'ภาษีมูลค่าเพิ่ม', amount: '0.00' });
    const m = await issue([{ taxCode: 'S7', unitPrice: '1000.00' }, { taxCode: 'Z0', unitPrice: '500.00' }, { taxCode: 'EX', unitPrice: '200.00' }]);
    expect(m.paper.vatLines).toEqual([
      { label: 'ยอดขายอัตราร้อยละ 0', amount: '500.00' }, { label: 'ยอดขายที่ได้รับยกเว้น', amount: '200.00' },
      { label: 'ภาษีมูลค่าเพิ่ม 7%', amount: m.doc.totals.vat },
    ]);
    expect(m.doc.totals.vat).toBe('70.00');
  });
});

describe('ledger 186: the confirm endpoint reports a vanished plan as plan_stale', () => {
  it('a document cancelled after the plan was built is plan_stale (409), not a raw doc.not_correctable', async () => {
    const d = await (await call('POST', '/docs/TI', body())).json();
    const issued = await (await call('POST', `/docs/TI/${d.id}/issue`, { version: d.version })).json();
    const plan = await (await call('POST', `/docs/TI/${d.id}/correction-plan`, { header: issued.header, lines: [{ ...issued.lines[0], unitPrice: '900.00' }] })).json();
    expect(plan.steps.length).toBeGreaterThan(0);
    expect((await call('POST', `/docs/TI/${d.id}/cancel`, { version: issued.version, reasonCode: 'OTHER', reasonText: 'x' })).status).toBe(200);
    const r = await call('POST', '/corrections', { planId: plan.planId, planHash: plan.planHash });
    expect(r.status).toBe(409);
    expect((await r.json()).code).toBe('correction.plan_stale');
  });
});

describe('credit and debit notes over HTTP (S5): the reference, the customer and the VAT belong to the server', () => {
  const issuedTi = async () => {
    const d = await (await call('POST', '/docs/TI', body())).json();
    return (await call('POST', `/docs/TI/${d.id}/issue`, { version: d.version })).json() as Promise<{ id: string; version: number; lines: { id: string }[] }>;
  };
  const cn = (ti: { id: string; lines: { id: string }[] }, price: string, extra: Record<string, unknown> = {}) => ({
    header: { documentDate: '2026-10-14', refDocId: ti.id, reasonCode: 'RETURN', ...extra },
    lines: [{ id: 'n1', description: 'คืนสินค้า', qty: '1', unit: 'งาน', unitPrice: price, taxCode: 'S7', sourceLineId: ti.lines[0].id, vatOverride: '9.99' }],
  });
  it("a client's customer and VAT are ignored; the issued CN names the invoice's customer and carries rule B VAT; the TI follows", async () => {
    const ti = await issuedTi();
    const other = loadState().parties.find((p) => p.companyId === 'co-vat' && p.kind === 'customer' && p.id !== partyId())!.id;
    const d = await (await call('POST', '/docs/CN', cn(ti, '400.00', { partyId: other }))).json();
    const issued = await (await call('POST', `/docs/CN/${d.id}/issue`, { version: d.version })).json();
    expect(issued.header.partyId).toBe(partyId());
    expect(issued.lines[0].vatOverride).toBe('28.00'); // 7% of 400.00 off the 1,000.00 line, not the 9.99 the client sent
    expect(issued.totals.total).toBe('428.00');
    expect((await (await call('GET', `/docs/TI/${ti.id}`)).json()).outstanding).toBe('642.00');
    expect((await (await call('GET', `/docs/CN/${d.id}/paper`)).json()).adjusts).toMatchObject({ originalNet: '1000.00', correctNet: '600.00', diffNet: '400.00', reason: 'รับคืนสินค้า / สินค้าชำรุด' });
  });
  it('more than the line holds -> 422 cn.exceeds_original; no invoice -> 422 doc.incomplete', async () => {
    const ti = await issuedTi();
    const d = await (await call('POST', '/docs/CN', cn(ti, '1000.01'))).json();
    const r = await call('POST', `/docs/CN/${d.id}/issue`, { version: d.version });
    expect(r.status).toBe(422);
    expect((await r.json()).code).toBe('cn.exceeds_original');
    const bare = await (await call('POST', '/docs/CN', { ...cn(ti, '1.00'), header: { documentDate: '2026-10-14', partyId: partyId(), reasonCode: 'RETURN' } })).json();
    expect((await (await call('POST', `/docs/CN/${bare.id}/issue`, { version: bare.version })).json()).code).toBe('doc.incomplete');
  });
  it('the non-VAT company has no credit notes (404) and an operator cannot create one (403)', async () => {
    const ti = await issuedTi();
    setSettings({ role: 'operator' });
    expect((await call('POST', '/docs/CN', cn(ti, '1.00'))).status).toBe(403);
    setSettings({ role: 'accountant', companyKey: 'nonvat' });
    const r = await call('POST', '/docs/CN', cn(ti, '1.00'));
    expect(r.status).toBe(404);
    expect((await r.json()).code).toBe('doc.type_not_available');
  });
});
