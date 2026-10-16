import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Doc, PaperModel } from '@/domain/types';
import type { RecordRow } from '@/domain/records';
import { revise } from '../engine/commands';
import { fixtureIds } from '../fixtures/ids';
import { setSettings } from '../settings';
import { loadState, resetState, saveState } from '../store';
import { testServer } from '../test-server';

beforeAll(() => testServer.listen({ onUnhandledFrame: 'error' }));
afterEach(() => testServer.resetHandlers());
afterAll(() => testServer.close());
let ids: ReturnType<typeof fixtureIds>;
beforeEach(() => { localStorage.clear(); resetState(); setSettings({ companyKey: 'vat', role: 'accountant', screenState: 'normal' }); ids = fixtureIds(loadState()); });

const call = (method: string, p: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(`http://localhost/bff/v1${p}`, { method, body: body ? JSON.stringify(body) : undefined, headers: { 'content-type': 'application/json', ...headers } });
const json = async <T = Doc>(r: Response) => (await r.json()) as T;
const off = async (id: string) => {
  const cur = await json<RecordRow>(await call('GET', `/records/bank-account/${id}`));
  expect((await call('POST', `/records/bank-account/${id}/active`, { active: false, version: cur.version })).status).toBe(200);
};
const rcBody = (header: object, target?: string) => ({ header: { partyId: 'pc-01', documentDate: '2026-10-14', ...header }, lines: [], allocations: [{ targetId: target ?? ids.rcTargetsA, targetType: 'TI', amount: '1000.00' }] });
const issueRc = async (header: object, target?: string) => {
  const d = await json(await call('POST', '/docs/RC', rcBody(header, target)));
  const r = await call('POST', `/docs/RC/${d.id}/issue`, { version: d.version });
  expect(r.status).toBe(200);
  return json(r);
};
const pvBody = (bank: string) => ({ header: { partyId: 'pv-03', documentDate: '2026-10-14', paymentMethod: 'transfer', bankAccountId: bank }, lines: [{ id: 'l1', description: 'x', qty: '1', unit: 'u', unitPrice: '100.00', taxCode: 'EX' }] });
const rename = async (id: string, accountName: string, accountNo?: string) => {
  const cur = await json<RecordRow>(await call('GET', `/records/bank-account/${id}`));
  const r = await call('PUT', `/records/bank-account/${id}`, { kind: cur.kind, bankName: cur.bankName, accountNo: accountNo ?? cur.accountNo, accountName, accountCode: cur.accountCode, version: cur.version });
  expect(r.status).toBe(200);
};
const paper = async (type: string, id: string) => { const r = await call('GET', `/docs/${type}/${id}/paper`); const j = await r.json(); if (r.status !== 200) throw new Error(`${r.status} ${JSON.stringify(j)}`); return j as PaperModel; };

describe('I1: the inactive-account rule judges the account the document will really use', () => {
  it('a new cash receipt after the cash box is closed is refused, naming where to open it again', async () => {
    await off('ba-cash');
    const r = await call('POST', '/docs/RC', rcBody({ paymentMethod: 'cash' }));
    expect(r.status).toBe(422);
    const p = await json<{ code: string; title: string }>(r);
    expect(p.code).toBe('pay.inactive_bank_account');
    expect(p.title).toContain('บัญชีธนาคารและเงินสด');
    expect(p.title).toContain('เงินสดย่อย');
  });
  it('a cash receipt carrying a stale closed bank id is fine (that bank is not used); a draft made before the close keeps and issues', async () => {
    const draft = await json(await call('POST', '/docs/RC', rcBody({ paymentMethod: 'cash' })));
    await off('ba-scb');
    expect((await call('POST', '/docs/RC', rcBody({ paymentMethod: 'cash', bankAccountId: 'ba-scb' }))).status).toBe(201); // the closed bank is not the account used
    await off('ba-cash');
    expect((await call('PUT', `/docs/RC/${draft.id}`, { ...rcBody({ paymentMethod: 'cash' }), version: draft.version })).status).toBe(200);
    const again = await json(await call('GET', `/docs/RC/${draft.id}`));
    expect((await call('POST', `/docs/RC/${draft.id}/issue`, { version: again.version })).status).toBe(200);
  });
  it('switching a draft from a bank to the closed cash box is refused; a PV on the closed cash box is refused too', async () => {
    const d = await json(await call('POST', '/docs/RC', rcBody({ paymentMethod: 'transfer', bankAccountId: 'ba-kbank' })));
    await off('ba-cash');
    const sw = await call('PUT', `/docs/RC/${d.id}`, { ...rcBody({ paymentMethod: 'cash' }), version: d.version });
    expect(sw.status).toBe(422);
    expect((await json<{ code: string }>(sw)).code).toBe('pay.inactive_bank_account');
    expect((await call('POST', '/docs/PV', { ...pvBody('ba-kbank'), header: { ...pvBody('ba-kbank').header, paymentMethod: 'cash' } })).status).toBe(422);
  });
});

describe('I2: a correction cannot re-point a document to a closed account', () => {
  it('plan: a closed proposed bank is refused; keeping the original (closed) one is allowed', async () => {
    const issued = await issueRc({ paymentMethod: 'transfer', bankAccountId: 'ba-kbank' });
    await off('ba-scb');
    const repoint = await call('POST', `/docs/RC/${issued.id}/correction-plan`, { header: { ...issued.header, bankAccountId: 'ba-scb' }, lines: [], allocations: issued.allocations });
    expect(repoint.status).toBe(422);
    expect((await json<{ code: string }>(repoint)).code).toBe('pay.inactive_bank_account');

    const onScb = await issueRc({ paymentMethod: 'transfer', bankAccountId: 'ba-cash' }, ids.rcTargetsB); // original on the cash box, later closed
    await off('ba-cash');
    const keep = await call('POST', `/docs/RC/${onScb.id}/correction-plan`, { header: { ...onScb.header, notes: 'x' }, lines: [], allocations: onScb.allocations });
    expect(keep.status).toBe(200);
    const toCash = await call('POST', `/docs/RC/${issued.id}/correction-plan`, { header: { ...issued.header, paymentMethod: 'cash', bankAccountId: undefined }, lines: [], allocations: issued.allocations });
    expect(toCash.status).toBe(422); // cash resolves to the closed cash box
  });
  it('/corrections: a plan made while the bank was open is refused once it has closed', async () => {
    const issued = await issueRc({ paymentMethod: 'transfer', bankAccountId: 'ba-kbank' });
    const plan = await json<{ planId: string; planHash: string }>(await call('POST', `/docs/RC/${issued.id}/correction-plan`, { header: { ...issued.header, bankAccountId: 'ba-scb' }, lines: [], allocations: issued.allocations }));
    expect(plan.planId).toBeTruthy();
    await off('ba-scb');
    const run = await call('POST', '/corrections', { planId: plan.planId, planHash: plan.planHash });
    expect(run.status).toBe(422);
    expect((await json<{ code: string }>(run)).code).toBe('pay.inactive_bank_account');
    expect(loadState().docs.find((d) => d.id === issued.id)!.status).toBe('issued'); // nothing was cancelled
  });
});

describe('I3: an issued receipt / voucher prints the account as it was at issue', () => {
  it('RC: rename and re-number the account, the paper is unchanged; a draft has no snapshot; a revise refreshes', async () => {
    const issued = await issueRc({ paymentMethod: 'transfer', bankAccountId: 'ba-scb' });
    expect(issued.header.bankSnapshot).toEqual({ kind: 'bank', bankName: 'scb', accountNo: '405-2-11223-4', accountName: 'ไทยพาณิชย์ ออมทรัพย์' });
    const before = (await paper('RC', issued.id)).payment;
    expect(before).toContain('ไทยพาณิชย์ ออมทรัพย์ 405-2-11223-4');
    await rename('ba-scb', 'SCB เปลี่ยนชื่อ', '405-2-99999-9');
    expect((await paper('RC', issued.id)).payment).toBe(before);

    const draft = await json(await call('POST', '/docs/RC', rcBody({ paymentMethod: 'transfer', bankAccountId: 'ba-scb' })));
    expect(draft.header.bankSnapshot).toBeUndefined(); // a draft has no paper and no snapshot: it reads the live account

    // a revise (notes only) re-takes the snapshot: it is a new revision of the document, and the account is read again
    const st = loadState();
    const cur = st.docs.find((d) => d.id === issued.id)!;
    const revised = revise(st, issued.id, { header: { ...cur.header, notes: 'หมายเหตุใหม่' }, lines: cur.lines, allocations: cur.allocations }, cur.version, 'แก้ไขหมายเหตุ', { kind: 'user', id: 'u-1', name: 'x' });
    expect(revised.header.bankSnapshot).toMatchObject({ accountName: 'SCB เปลี่ยนชื่อ', accountNo: '405-2-99999-9' });
  });
  it('a caller cannot forge the snapshot', async () => {
    const forged = { kind: 'bank', bankName: 'scb', accountNo: '1', accountName: 'ปลอม' };
    const d = await json(await call('POST', '/docs/RC', rcBody({ paymentMethod: 'transfer', bankAccountId: 'ba-kbank', bankSnapshot: forged })));
    expect(d.header.bankSnapshot).toBeUndefined();
    const r = await call('POST', `/docs/RC/${d.id}/issue`, { version: d.version });
    expect((await json(r)).header.bankSnapshot).toMatchObject({ accountName: 'กสิกรไทย กระแสรายวัน' });
  });
  it('PV: same - a cash voucher snapshots the cash box, a transfer voucher the bank', async () => {
    const d = await json(await call('POST', '/docs/PV', pvBody('ba-scb')));
    const r = await call('POST', `/docs/PV/${d.id}/issue`, { version: d.version });
    expect(r.status).toBe(200);
    const issued = await json(r);
    expect(issued.header.bankSnapshot).toMatchObject({ kind: 'bank', accountName: 'ไทยพาณิชย์ ออมทรัพย์' });
    const before = (await paper('PV', issued.id)).payment;
    await rename('ba-scb', 'ชื่อใหม่');
    expect((await paper('PV', issued.id)).payment).toBe(before);
    const c = await json(await call('POST', '/docs/PV', { ...pvBody('ba-scb'), header: { ...pvBody('ba-scb').header, paymentMethod: 'cash' } }));
    const ci = await json(await call('POST', `/docs/PV/${c.id}/issue`, { version: c.version }));
    expect(ci.header.bankSnapshot).toEqual({ kind: 'cash', accountName: 'เงินสดย่อย' });
  });
  it('the seeded issued receipts carry a snapshot too', () => {
    const rcs = loadState().docs.filter((d) => d.type === 'RC' && d.status !== 'draft' && d.header.bankAccountId);
    expect(rcs.length).toBeGreaterThan(0);
    expect(rcs.every((d) => d.header.bankSnapshot)).toBe(true);
  });
});

describe('M1: a GL account used for something else cannot be bound to a bank account', () => {
  const NEW = { kind: 'bank', bankName: 'bbl', accountNo: '999-9-99999-9', accountName: 'กรุงเทพ ออมทรัพย์' };
  const post = (accountCode: string) => call('POST', '/records/bank-account', { ...NEW, accountCode }, { 'Idempotency-Key': crypto.randomUUID() });
  it('the keyless Cash default (1120) is refused; the free account is accepted', async () => {
    const r = await post('1120');
    expect(r.status).toBe(422);
    const msg = (await json<{ fieldErrors: Record<string, string[]> }>(r)).fieldErrors.accountCode[0];
    expect(msg).toContain('Cash');
    expect((await post('1123')).status).toBe(201);
  });
  it('an account that journal lines already use for something else is refused, naming the document', async () => {
    const st = loadState();
    const j = st.journals.find((x) => x.preview.entries.some((e) => e.lines.some((l) => l.accountCode === '1130')))!;
    // 1130 is a receivable, not selectable at all; prove the journal rule on a selectable code by posting onto 1123 first
    const ent = j.preview.entries[0];
    ent.lines.push({ ...ent.lines[0], accountCode: '1123' });
    saveState(st);
    const r = await post('1123');
    expect(r.status).toBe(422);
    expect((await json<{ fieldErrors: Record<string, string[]> }>(r)).fieldErrors.accountCode[0]).toContain('รายการบัญชี');
  });
  it('the GL list marks them taken', async () => {
    const list = await json<{ code: string; taken: boolean }[]>(await call('GET', '/finance/bank-gl-accounts'));
    expect(list.find((a) => a.code === '1120')!.taken).toBe(true);
    expect(list.find((a) => a.code === '1123')!.taken).toBe(false);
  });
});

describe('M2: the account number is frozen once the account has an import', () => {
  it('kbank (seeded import) cannot be re-numbered; scb (no import) can', async () => {
    const kb = await json<RecordRow>(await call('GET', '/records/bank-account/ba-kbank'));
    const r = await call('PUT', '/records/bank-account/ba-kbank', { kind: 'bank', bankName: 'kbank', accountNo: '012-3-00000-0', accountName: kb.accountName, accountCode: '1121', version: kb.version });
    expect(r.status).toBe(422);
    expect((await json<{ fieldErrors: Record<string, string[]> }>(r)).fieldErrors.accountNo[0]).toContain('นำเข้า');
    await rename('ba-kbank', 'ชื่อใหม่'); // the name is free
    await rename('ba-scb', 'x', '405-2-99999-9');
  });
});
