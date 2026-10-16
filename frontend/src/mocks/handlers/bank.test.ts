import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { BankImport, BankLine, Page } from '@/domain/types';
import type { RecordRow } from '@/domain/records';
import { KBIZ_2026_10, KBIZ_OCT_NAME } from '../fixtures/statements/kbiz-2026-10.csv';
import { fixtureIds } from '../fixtures/ids';
import { setSettings } from '../settings';
import { loadState, resetState } from '../store';
import { testServer } from '../test-server';
import { handlers } from '.';

beforeAll(() => testServer.listen({ onUnhandledFrame: 'error' }));
afterEach(() => testServer.resetHandlers());
afterAll(() => testServer.close());
beforeEach(() => { localStorage.clear(); resetState(); setSettings({ companyKey: 'vat', role: 'accountant', screenState: 'normal' }); });

const call = (method: string, p: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(`http://localhost/bff/v1${p}`, { method, body: body ? JSON.stringify(body) : undefined, headers: { 'content-type': 'application/json', ...headers } });
const rows = async (q = '') => ((await (await call('GET', `/records/bank-account?active=all${q}`)).json()) as Page<RecordRow>).items;
const NEW = { kind: 'bank', bankName: 'bbl', accountNo: '999-9-99999-9', accountName: 'กรุงเทพ ออมทรัพย์', accountCode: '1120' };
const rc = (bank: string, ids = fixtureIds(loadState())) => ({ header: { partyId: 'pc-01', documentDate: '2026-10-14', paymentMethod: 'transfer', bankAccountId: bank }, lines: [],
  allocations: [{ targetId: ids.rcTargetsA, targetType: 'TI', amount: '1000.00' }] });

describe('one source of bank accounts', () => {
  it('the F5 stopgap handler is gone: nothing answers /bff/v1/bank-accounts', () => {
    const paths = handlers.map((h) => String((h as unknown as { info: { path: string } }).info.path));
    expect(paths.filter((p) => /bff\/v1\/bank-accounts$/.test(p))).toEqual([]);
    expect(paths).toContain('*/bff/v1/records/:kind');
  });
  it('rows carry the form fields, the default flag and inUse (a journal line posts to the GL account)', async () => {
    const list = await rows();
    expect(list.map((r) => r.id)).toEqual(['ba-cash', 'ba-kbank', 'ba-scb']);
    expect(list.find((r) => r.id === 'ba-kbank')).toMatchObject({ kind: 'bank', bankName: 'kbank', accountNo: '012-3-45678-9', accountName: 'กสิกรไทย กระแสรายวัน', accountCode: '1121', default: true, active: true, inUse: true });
    expect(list.find((r) => r.id === 'ba-scb')).toMatchObject({ accountCode: '1122', inUse: false });
    expect(list.find((r) => r.id === 'ba-cash')).toMatchObject({ kind: 'cash', accountCode: '1110' });
    expect(list.find((r) => r.id === 'ba-cash')).not.toHaveProperty('accountNo');
  });
  it('permissions: operator reads, accountant and admin manage, nobody reads another company', async () => {
    setSettings({ role: 'operator' });
    expect((await call('GET', '/records/bank-account')).status).toBe(200);
    const denied = await call('POST', '/records/bank-account', NEW);
    expect(denied.status).toBe(403);
    expect((await denied.json()).detail).toContain('bank.manage');
    setSettings({ role: 'admin' });
    expect((await call('POST', '/records/bank-account', NEW, { 'Idempotency-Key': 'a' })).status).toBe(201);
    setSettings({ companyKey: 'nonvat', role: 'operator' });
    expect((await rows()).map((r) => r.id)).toEqual(['nba-cash', 'nba-kbank']);
    expect((await call('GET', '/records/bank-account/ba-kbank')).status).toBe(404);
  });
});

describe('create / validate (§5.13: its own GL account)', () => {
  const post = async (v: object) => call('POST', '/records/bank-account', v, { 'Idempotency-Key': crypto.randomUUID() });
  const errors = async (v: object) => ((await (await post(v)).json()) as { fieldErrors: Record<string, string[]> }).fieldErrors;

  it('creates an account bound to a free GL account, and the Cash role then posts to it', async () => {
    const r = await post(NEW);
    expect(r.status).toBe(201);
    const row = (await r.json()) as RecordRow;
    expect(row).toMatchObject({ id: 'ba-4', accountCode: '1120', inUse: false, active: true });
    expect(loadState().postingRules).toContainEqual({ companyId: 'co-vat', level: 'default', key: 'ba-4', role: 'Cash', accountCode: '1120' });
    // a receipt into it: the journal's cash line is on 1120, and the account is frozen from then on
    const d = await (await call('POST', '/docs/RC', rc('ba-4'))).json();
    const done = await (await call('POST', `/docs/RC/${d.id}/issue`, { version: d.version })).json();
    expect(done.status).toBe('issued');
    const st = loadState();
    expect(st.journals.find((j) => j.docId === d.id)!.preview.entries[0].lines.some((l) => l.accountCode === '1120' && l.debit !== '0.00')).toBe(true);
    expect((await rows()).find((x) => x.id === 'ba-4')!.inUse).toBe(true);
  });
  it('one GL account per bank account; postable current-asset of the matching type', async () => {
    expect(await errors({ ...NEW, accountCode: '1121' })).toHaveProperty('accountCode'); // owned by ba-kbank
    expect(await errors({ ...NEW, accountCode: '1130' })).toHaveProperty('accountCode'); // receivable: not a cash / bank account
    expect(await errors({ ...NEW, accountCode: '1100' })).toHaveProperty('accountCode'); // a header, not postable
    expect(await errors({ ...NEW, accountCode: '4100' })).toHaveProperty('accountCode'); // revenue
    expect(await errors({ ...NEW, accountCode: '9999' })).toHaveProperty('accountCode'); // unknown
    expect(await errors({ ...NEW, kind: 'cash', accountCode: '1120' })).toHaveProperty('accountCode'); // a cash box on a bank GL account
  });
  it('bank needs bank, number (10-15 digits, dashes allowed, unique) and name; a cash box needs neither bank nor number', async () => {
    expect(Object.keys(await errors({ kind: 'bank', accountCode: '1120' })).sort()).toEqual(['accountName', 'accountNo', 'bankName']);
    expect(await errors({ ...NEW, accountNo: '12345' })).toHaveProperty('accountNo');
    expect(await errors({ ...NEW, accountNo: 'abc-1234567' })).toHaveProperty('accountNo');
    expect(await errors({ ...NEW, accountNo: '0123456789' })).toHaveProperty('accountNo'); // = ba-kbank's, digits compared
    expect(await errors({ ...NEW, bankName: 'nope' })).toHaveProperty('bankName');
    expect(await errors({ ...NEW, kind: 'nope' })).toHaveProperty('kind');
    const cash = await post({ kind: 'cash', accountName: 'เงินสดสาขา', accountCode: '1110', bankName: 'kbank', accountNo: '999-9-99999-9' });
    expect((await cash.json()).fieldErrors).toHaveProperty('accountCode'); // 1110 is ba-cash's
  });
});

describe('the GL account is frozen once a journal line posts to it', () => {
  const put = async (id: string, v: object) => {
    const cur = (await (await call('GET', `/records/bank-account/${id}`)).json()) as RecordRow;
    return call('PUT', `/records/bank-account/${id}`, { ...v, version: cur.version });
  };
  const base = (r: RecordRow) => ({ kind: r.kind, bankName: r.bankName, accountNo: r.accountNo, accountName: r.accountName, accountCode: r.accountCode });

  it('a used account keeps its code (the name may change); an unused one may move, and its posting rule follows', async () => {
    const kbank = (await rows()).find((r) => r.id === 'ba-kbank')!;
    const refused = await put('ba-kbank', { ...base(kbank), accountCode: '1120' });
    expect(refused.status).toBe(422);
    expect((await refused.json()).fieldErrors.accountCode[0]).toContain('หลังจากมีรายการบัญชี');
    expect((await put('ba-kbank', { ...base(kbank), accountName: 'กสิกรไทย (หลัก)' })).status).toBe(200);
    expect((await rows()).find((r) => r.id === 'ba-kbank')).toMatchObject({ accountCode: '1121', accountName: 'กสิกรไทย (หลัก)' });

    const journals = JSON.stringify(loadState().journals);
    const scb = (await rows()).find((r) => r.id === 'ba-scb')!;
    expect((await put('ba-scb', { ...base(scb), accountCode: '1120' })).status).toBe(200);
    const st = loadState();
    expect(st.postingRules.find((r) => r.key === 'ba-scb' && r.role === 'Cash')!.accountCode).toBe('1120');
    expect(JSON.stringify(st.journals)).toBe(journals); // history carries its codes: a later edit cannot move it
  });
  it('after the first posting the account is frozen: move it, post once, move it again', async () => {
    const scb = (await rows()).find((r) => r.id === 'ba-scb')!;
    expect((await put('ba-scb', { ...base(scb), accountCode: '1120' })).status).toBe(200);
    const d = await (await call('POST', '/docs/RC', rc('ba-scb'))).json();
    await call('POST', `/docs/RC/${d.id}/issue`, { version: d.version });
    const moved = await put('ba-scb', { ...base(scb), accountCode: '1122' });
    expect(moved.status).toBe(422);
    expect(loadState().journals.find((j) => j.docId === d.id)!.preview.entries[0].lines.some((l) => l.accountCode === '1120')).toBe(true);
  });
});

describe('inactive accounts', () => {
  const off = async (id: string) => {
    const cur = (await (await call('GET', `/records/bank-account/${id}`)).json()) as RecordRow;
    return call('POST', `/records/bank-account/${id}/active`, { active: false, version: cur.version });
  };
  it('cannot be picked on a new document or switched to on a draft, but a document that already has it keeps it', async () => {
    const draft = await (await call('POST', '/docs/RC', rc('ba-scb'))).json(); // picked while it was open
    expect((await off('ba-scb')).status).toBe(200);
    const created = await call('POST', '/docs/RC', rc('ba-scb'));
    expect(created.status).toBe(422);
    expect((await created.json()).code).toBe('pay.inactive_bank_account');
    const other = await (await call('POST', '/docs/RC', rc('ba-kbank'))).json();
    const switched = await call('PUT', `/docs/RC/${other.id}`, { ...rc('ba-scb'), version: other.version });
    expect(switched.status).toBe(422);
    const kept = await call('PUT', `/docs/RC/${draft.id}`, { ...rc('ba-scb'), version: draft.version });
    expect(kept.status).toBe(200);
    // still listed for the document that shows it, flagged inactive
    expect((await rows()).find((r) => r.id === 'ba-scb')).toMatchObject({ active: false });
    expect((await call('GET', '/records/bank-account')).status).toBe(200);
    const open = ((await (await call('GET', '/records/bank-account')).json()) as Page<RecordRow>).items.map((r) => r.id);
    expect(open).not.toContain('ba-scb');
  });
  it('the company default account cannot be closed', async () => {
    const r = await off('ba-kbank');
    expect(r.status).toBe(409);
    expect((await r.json()).detail).toContain('บัญชีตั้งต้น');
  });
});

describe('POST /finance/bank-accounts/:id/imports and GET .../lines', () => {
  const upload = (id: string, body: object) => call('POST', `/finance/bank-accounts/${id}/imports`, body);
  const lines = async (id: string, q = '') => (await (await call('GET', `/finance/bank-accounts/${id}/lines${q}`)).json()) as Page<BankLine>;

  it('seed: ba-kbank has its 18 September lines, ba-scb none; newest first; filterable', async () => {
    const l = await lines('ba-kbank');
    expect(l.total).toBe(18);
    expect(l.items[0]).toMatchObject({ date: '2026-09-30', status: 'unmatched' });
    expect((await lines('ba-scb')).items).toEqual([]);
    expect((await lines('ba-kbank', '?from=2026-09-17&to=2026-09-23')).total).toBe(4);
    expect((await lines('ba-kbank', '?status=matched')).total).toBe(0);
    expect((await call('GET', '/finance/bank-accounts/ba-kbank/lines?status=nope')).status).toBe(422);
    expect((await call('GET', '/finance/bank-accounts/nba-kbank/lines')).status).toBe(404); // the other company's account is not visible here
  });
  it('imports the October CSV: 201, lines appended, nothing posted, one audit entry, the raw file attached', async () => {
    const before = loadState();
    const r = await upload('ba-kbank', { fileName: KBIZ_OCT_NAME, format: 'kbiz-csv', content: KBIZ_2026_10 });
    expect(r.status).toBe(201);
    const imp = (await r.json()) as BankImport;
    expect(imp).toMatchObject({ lines: 12, from: '2026-10-01', to: '2026-10-13', warnings: [] });
    const after = loadState();
    expect(after.bankLines.length).toBe(before.bankLines.length + 12);
    expect(after.journals.length).toBe(before.journals.length);
    expect(after.audit.filter((a) => a.command === 'bank.import')).toHaveLength(before.audit.filter((a) => a.command === 'bank.import').length + 1);
    expect(after.attachments.some((a) => a.docId === imp.id && a.name === KBIZ_OCT_NAME)).toBe(true);
    expect((await lines('ba-kbank')).total).toBe(30);
  });
  it('a refused file leaves the state untouched; operator may not import; a cash box has no statements', async () => {
    const before = JSON.stringify(loadState().bankLines);
    const bad = await upload('ba-kbank', { fileName: 'x.csv', format: 'kbiz-csv', content: KBIZ_2026_10.replace('012-3-45678-9', '111-1-11111-1') });
    expect(bad.status).toBe(422);
    expect((await bad.json()).code).toBe('bank.account_mismatch');
    expect(JSON.stringify(loadState().bankLines)).toBe(before);
    expect((await upload('ba-cash', { fileName: 'x.csv', format: 'kbiz-csv', content: KBIZ_2026_10 })).status).toBe(422);
    setSettings({ role: 'operator' });
    const denied = await upload('ba-kbank', { fileName: KBIZ_OCT_NAME, format: 'kbiz-csv', content: KBIZ_2026_10 });
    expect(denied.status).toBe(403);
    expect((await lines('ba-kbank')).total).toBe(18); // reading is allowed
  });
  it('a refused state write is a 507 and nothing half-written (the file bytes are dropped too)', async () => {
    const real = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k: string, v: string) { if (k.startsWith('teas2.mock.state.')) throw new DOMException('full', 'QuotaExceededError'); return real.call(this, k, v); };
    try {
      const r = await upload('ba-kbank', { fileName: KBIZ_OCT_NAME, format: 'kbiz-csv', content: KBIZ_2026_10 });
      expect(r.status).toBe(507);
    } finally { Storage.prototype.setItem = real; }
    expect(loadState().bankLines.filter((l) => l.accountId === 'ba-kbank')).toHaveLength(18);
    expect(Object.keys(localStorage).filter((k) => k.startsWith('teas2.mock.att.att-seed-bi-'))).toHaveLength(2); // the two seeded files only
  });
});
