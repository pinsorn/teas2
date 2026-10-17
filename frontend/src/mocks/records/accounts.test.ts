import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { RecordRow } from '@/domain/records';
import type { DocLine } from '@/domain/types';
import { DBD_LINES, GROUP_OF, PND50_BOXES } from '@/records/accounts';
import { chartOfAccounts } from '../fixtures/coa';
import { checkInvariants } from '../engine/invariants';
import { jvAccountProblem } from '../engine/journal';
import { post } from '../engine/reconcile';
import { setSettings } from '../settings';
import { loadState, resetState, saveState, type MockState } from '../store';
import { testServer } from '../test-server';

beforeAll(() => testServer.listen({ onUnhandledFrame: 'error' }));
afterEach(() => testServer.resetHandlers());
afterAll(() => testServer.close());
beforeEach(() => { localStorage.clear(); resetState(); setSettings({ companyKey: 'vat', role: 'accountant', screenState: 'normal' }); });

const call = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`http://localhost/bff/v1${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, unknown> & Partial<RecordRow> & { code?: string; title?: string; fieldErrors?: Record<string, string[]> } };
};
const list = async (q = '') => ((await call('GET', `/records/account?active=all&limit=100${q}`)).json as unknown as { items: RecordRow[]; total: number });
const get = async (id: string) => (await call('GET', `/records/account/${id}`)).json as RecordRow;
const valid = { code: '5190', nameTh: 'ค่าใช้จ่ายเบ็ดเตล็ด', parent: '5000', postable: true, class: 'selling-admin-expense', subClass: 'expense' };
const create = (over: Record<string, unknown> = {}) => call('POST', '/records/account', { ...valid, ...over });
const put = async (id: string, over: Record<string, unknown>) => { const r = await get(id); return call('PUT', `/records/account/${id}`, { ...valid, ...pick(r), ...over, version: r.version }); };
const pick = (r: RecordRow) => ({ code: r.code, nameTh: r.nameTh, nameEn: r.nameEn, parent: r.parent, postable: r.postable, class: r.class, subClass: r.subClass, dbdLine: r.dbdLine, pnd50Box: r.pnd50Box });
const setActive = async (id: string, active: boolean) => { const r = await get(id); return call('POST', `/records/account/${id}/active`, { active, version: r.version }); };
/** Writes a bank journal (fee-style) that puts `amount` on `code` against 1121: the account is now used and carries a balance. */
function giveBalance(code: string, side: 'debit' | 'credit' = 'debit') {
  const st = loadState();
  const mk = (accountCode: string, debit: string, credit: string) => ({ accountCode, accountName: accountCode, debit, credit, rule: 'test' });
  st.bankJournals.push({ id: 'bj-test', companyId: 'co-vat', accountId: 'ba-kbank', kind: 'fee', label: 'test',
    entries: [{ date: '2026-09-10', kind: 'original', lines: side === 'debit' ? [mk(code, '100.00', '0.00'), mk('1121', '0.00', '100.00')] : [mk('1121', '100.00', '0.00'), mk(code, '0.00', '100.00')] }] });
  saveState(st);
}
const withState = (f: (st: MockState) => void) => { const st = loadState(); f(st); saveState(st); };

describe('chart of accounts record (AC2)', () => {
  it('lists the company chart as records: id = code, parent, class, in-use flag; the other company is separate', async () => {
    const { items } = await list();
    const r = items.find((x) => x.code === '1130')!;
    expect(r).toMatchObject({ id: '1130', name: 'ลูกหนี้การค้า', parent: '1100', postable: true, class: 'current-asset', subClass: 'receivable', active: true, inUse: true, version: 1 });
    expect(items.find((x) => x.code === '1100')).toMatchObject({ postable: false, inUse: false });
    expect(items.find((x) => x.code === '1171')!.inUse).toBe(false); // (1150 is in use since AC4: the insurance bill pb-ins lands on it)
    expect(items.every((x) => typeof x.dbdLine === 'string' || !x.postable || x.class === 'equity' || x.class === 'current-asset')).toBe(true);
  });

  it('seeds only real statutory lines: every dbdLine / pnd50Box is in the lists; postable balance-sheet accounts have a DBD line, P&L accounts both', () => {
    const dbd = new Set<string>(DBD_LINES), p50 = new Set<string>(PND50_BOXES);
    expect(dbd.size).toBe(DBD_LINES.length); expect(p50.size).toBe(PND50_BOXES.length);
    for (const a of chartOfAccounts()) {
      if (a.dbdLine) expect(dbd.has(a.dbdLine), a.code).toBe(true);
      if (a.pnd50Box) expect(p50.has(a.pnd50Box), a.code).toBe(true);
      const pl = GROUP_OF[a.class] === 'revenue' || GROUP_OF[a.class] === 'expense';
      if (a.postable) { expect(a.dbdLine, a.code).toBeTruthy(); expect(!!a.pnd50Box, a.code).toBe(pl); } else expect(a.dbdLine ?? a.pnd50Box).toBeUndefined();
    }
    const by = (c: string) => chartOfAccounts().find((a) => a.code === c)!;
    expect(by('1211').dbdLine).toBe('bs-ppe'); expect(by('1180').dbdLine).toBe('bs-current-tax-asset'); expect(by('5300')).toMatchObject({ dbdLine: 'pl-administrative-expenses', pnd50Box: 'p50-sga-depreciation' }); expect(by('5600')).toMatchObject({ class: 'income-tax', dbdLine: 'pl-income-tax', pnd50Box: 'p50-income-tax' });
  });

  it('creates 5190 under 5000: audited, listed, and the ledger invariants still hold', async () => {
    const r = await create({ nameEn: 'Sundry expenses' });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ id: '5190', code: '5190', version: 1, active: true, inUse: false, nameEn: 'Sundry expenses' });
    const st = loadState();
    expect(st.audit.at(-1)).toMatchObject({ command: 'record.account.create', target: '5190', companyId: 'co-vat' });
    expect(st.accounts.some((a) => a.companyId === 'co-nonvat' && a.code === '5190')).toBe(false);
    expect(checkInvariants(st)).toEqual([]);
  });

  it('code: 4-6 digits and unique per company', async () => {
    for (const code of ['519', '1234567', '51A0', ' ']) expect((await create({ code })).json.fieldErrors?.code, code).toHaveLength(1);
    expect((await create({ code: '5110' })).json.fieldErrors?.code).toEqual(['รหัสบัญชีนี้ใช้แล้ว']);
    expect((await create({ code: '519000' })).status).toBe(201); // six digits are allowed
    expect((await put('1171', { code: '1140' })).json.fieldErrors?.code).toEqual(['รหัสบัญชีนี้ใช้แล้ว']);
  });

  it('renaming the header 1100 does not break bank accounts: the GL picker still lists the cash / bank accounts and a bank-account edit saves (review F1)', async () => {
    expect((await put('1100', { code: '1101' })).status).toBe(200);
    const gl = (await call('GET', '/finance/bank-gl-accounts')).json as unknown as { code: string }[];
    expect(gl.map((a) => a.code)).toEqual(['1110', '1120', '1121', '1122', '1123']);
    const b = (await call('GET', '/records/bank-account/ba-scb')).json as RecordRow;
    const r = await call('PUT', '/records/bank-account/ba-scb', { kind: 'bank', bankName: 'scb', accountNo: '405-2-11223-4', accountName: 'ไทยพาณิชย์ ออมทรัพย์ 2', accountCode: '1122', version: b.version });
    expect(r.status).toBe(200);
  });

  it('a controlled account keeps its class and sub-class even when unused and unmapped (review N1): 1171 and 1123 cannot be reclassified out of control', async () => {
    for (const [id, over] of [['1171', { subClass: 'current-asset' }], ['1123', { subClass: 'current-asset' }]] as const) {
      const r = await put(id, over);
      expect(r.json.code, id).toBe('account.controlled');
      expect((await get(id)).subClass, id).not.toBe(over.subClass);
    }
    expect((await put('1171', { nameTh: 'ภาษีซื้อรอเครดิต' })).status).toBe(200); // a rename is fine
  });

  it('shape: name required; class and sub-class valid and of the same group; a postable account needs a header parent; a header cannot be the parent of nothing postable-wise', async () => {
    expect((await create({ nameTh: ' ' })).json.fieldErrors?.nameTh).toHaveLength(1);
    expect((await create({ class: 'nonsense' })).json.fieldErrors?.class).toHaveLength(1);
    expect((await create({ subClass: 'receivable' })).json.fieldErrors?.subClass).toEqual(['ประเภทย่อยนี้ไม่ใช่ของหมวดบัญชีที่เลือก']);
    expect((await create({ parent: undefined })).json.fieldErrors?.parent).toEqual(['บัญชีที่ลงรายการได้ต้องอยู่ใต้บัญชีหมวด']);
    expect((await create({ parent: '5110' })).json.fieldErrors?.parent).toEqual(['ต้องเลือกบัญชีหมวด (ไม่ใช่บัญชีที่ลงรายการได้)']);
    expect((await create({ parent: '9999' })).json.fieldErrors?.parent).toEqual(['ไม่พบบัญชีหมวดนี้']);
    expect((await create({ parent: undefined, postable: false, subClass: 'header' })).status).toBe(201); // a top header
  });

  it('moving under a header of a different class (group) is refused; under one of the same group it is allowed', async () => {
    expect((await create({ parent: '1100' })).json.fieldErrors?.parent).toEqual(['ย้ายไปไว้ใต้บัญชีหมวดของหมวดอื่นไม่ได้ (หมวดสินทรัพย์ ≠ หมวดค่าใช้จ่าย)']);
    await create();
    expect((await put('5190', { parent: '1100' })).json.fieldErrors?.parent).toHaveLength(1);
    expect((await put('5190', { parent: '5000', nameTh: 'เบ็ดเตล็ด' })).status).toBe(200);
    expect((await get('5190')).name).toBe('เบ็ดเตล็ด');
  });

  it('a header cannot move under itself or its own descendant', async () => {
    await create({ code: '5900', parent: '5000', postable: false, subClass: 'header' });
    await create({ code: '5910', parent: '5900', postable: false, subClass: 'header' });
    expect((await put('5900', { parent: '5900' })).json.fieldErrors?.parent).toEqual(['ย้ายบัญชีหมวดไปไว้ใต้ตัวเองหรือบัญชีย่อยของตัวเองไม่ได้']);
    expect((await put('5900', { parent: '5910' })).json.fieldErrors?.parent).toHaveLength(1);
  });

  it('a header with sub-accounts cannot become postable (header accounts are never posted to)', async () => {
    expect((await put('5000', { postable: true })).json.fieldErrors?.postable).toEqual(['บัญชีหมวดที่มีบัญชีย่อยเปลี่ยนเป็นบัญชีที่ลงรายการได้ไม่ได้']);
  });

  describe('frozen once used (ruling 1)', () => {
    it('code, class, sub-class, postable are refused with account.in_use on a used account; name and statutory mapping are still editable', async () => {
      for (const over of [{ code: '1135' }, { class: 'non-current-asset' }, { subClass: 'prepayment' }, { postable: false }]) {
        const r = await put('1130', over);
        expect(r.status, JSON.stringify(over)).toBe(422);
        expect(r.json.code).toBe('account.in_use');
        expect(r.json.title).toContain('มีรายการบัญชีแล้ว');
      }
      expect((await get('1130')).code).toBe('1130');
      const ok = await put('1130', { nameTh: 'ลูกหนี้การค้า (ในประเทศ)', nameEn: 'Trade receivables', dbdLine: 'bs-other-current-assets' });
      expect(ok.status).toBe(200);
      expect(ok.json).toMatchObject({ name: 'ลูกหนี้การค้า (ในประเทศ)', nameEn: 'Trade receivables', dbdLine: 'bs-other-current-assets', version: 2 });
    });

    it('a used account may only move under a header of its present parent class', async () => {
      const r = await put('1130', { parent: '1200' });
      expect(r.json.code).toBe('account.in_use');
      await create({ code: '1190', parent: '1100', postable: false, subClass: 'header', class: 'current-asset' });
      expect((await put('1130', { parent: '1190' })).status).toBe(200);
    });

    it('"used" counts a journal line from any source: a bank journal, and a settlement record', async () => {
      await create();
      expect((await get('5190')).inUse).toBe(false);
      giveBalance('5190');
      expect((await get('5190')).inUse).toBe(true);
      expect((await put('5190', { code: '5191' })).json.code).toBe('account.in_use');
      await create({ code: '5192' });
      withState((st) => st.settlements.push({ id: 'stl-test', companyId: 'co-vat', kind: 'write_off', date: '2026-09-10', partyId: 'x', sources: [], targets: [], status: 'posted', createdBy: { kind: 'user', id: 'u-1', name: 'x' }, postedAt: '2026-09-10',
        journal: [{ date: '2026-09-10', kind: 'original', lines: [{ accountCode: '5192', accountName: 'x', debit: '1.00', credit: '0.00', rule: 't' }, { accountCode: '1130', accountName: 'x', debit: '0.00', credit: '1.00', rule: 't' }] }] }));
      expect((await get('5192')).inUse).toBe(true);
    });

    it('an unused account can still be re-coded: its sub-accounts follow; but not while a posting rule or a bank account points at the code', async () => {
      await create({ code: '5900', parent: '5000', postable: false, subClass: 'header' });
      await create({ code: '5910', parent: '5900' });
      expect((await put('5900', { code: '5901' })).status).toBe(200);
      expect((await get('5910')).parent).toBe('5901');
      expect((await call('GET', '/records/account/5900')).status).toBe(404);
      withState((st) => st.postingRules.push({ companyId: 'co-vat', level: 'default', role: 'Expense', accountCode: '5910' }));
      expect((await put('5910', { code: '5911' })).json.fieldErrors?.code?.[0]).toContain('กฎการลงบัญชี');
    });

    it('a NEW account is controlled by its sub-class like a seeded one: a tax-liability account is refused by a journal voucher; an ordinary expense account is not', async () => {
      await create({ code: '2195', parent: '2100', class: 'current-liability', subClass: 'tax-liability' });
      await create();
      const line = (accountCode: string): DocLine => ({ id: 'l1', accountCode, debit: '100.00', credit: '0.00' } as unknown as DocLine);
      const st = loadState();
      expect(jvAccountProblem(st, 'co-vat', [line('2195')])).toMatchObject({ code: 'ledger.control_account' });
      expect(jvAccountProblem(st, 'co-vat', [line('5190')])).toBeUndefined();
    });
  });

  describe('deactivate guards, each naming its exit (ruling 2)', () => {
    it('mapped by a posting rule: account.mapped names the rule and the exit', async () => {
      const r = await setActive('1130', false);
      expect(r.status).toBe(409);
      expect(r.json.code).toBe('account.mapped');
      expect(r.json.title).toContain('“AR”');
      expect(r.json.title).toContain('แก้ที่ ตั้งค่า → การลงบัญชี');
      expect((await get('1130')).active).toBe(true);
    });

    it('bound to a bank account: account.bank_bound names the bank account and the screen', async () => {
      const r = await setActive('1121', false);
      expect(r.status).toBe(409);
      expect(r.json.code).toBe('account.bank_bound');
      expect(r.json.title).toContain('กสิกรไทย กระแสรายวัน');
      expect(r.json.title).toContain('บัญชีธนาคารและเงินสด');
    });

    it('non-zero balance on an account a JV may post to: account.has_balance, exit = a journal voucher', async () => {
      await create();
      giveBalance('5190');
      const r = await setActive('5190', false);
      expect(r.json.code).toBe('account.has_balance');
      expect(r.json.title).toContain('โอนยอดออกด้วยสมุดรายวัน');
      expect(r.json.title).toContain('100.00');
    });

    it('non-zero balance on a CONTROLLED account: the exit names its owning document, not a journal voucher', async () => {
      await create({ code: '1195', parent: '1100', class: 'current-asset', subClass: 'tax-asset' });
      giveBalance('1195');
      const r = await setActive('1195', false);
      expect(r.json.code).toBe('account.has_balance');
      expect(r.json.title).toContain('บัญชีควบคุมภาษี');
      expect(r.json.title).not.toContain('โอนยอดออกด้วยสมุดรายวัน');
    });

    it('a used account with a zero balance deactivates; reactivating works; both are audited and bump the version', async () => {
      await create();
      giveBalance('5190');
      giveBalance('5190', 'credit'); // back to zero
      const off = await setActive('5190', false);
      expect(off.status).toBe(200);
      expect(off.json).toMatchObject({ active: false, version: 2 });
      const on = await setActive('5190', true);
      expect(on.json).toMatchObject({ active: true, version: 3 });
      expect(loadState().audit.map((a) => a.command).slice(-2)).toEqual(['record.account.deactivate', 'record.account.activate']);
    });

    it('a header with an active sub-account cannot be deactivated', async () => {
      const r = await setActive('5000', false);
      expect(r.json.code).toBe('account.has_children');
    });

    it('a stale version is a conflict, as for every record', async () => {
      const r = await get('1150');
      expect((await call('PUT', '/records/account/1150', { ...valid, ...pick(r), version: 99 })).json.code).toBe('record.version_conflict');
      expect((await call('POST', '/records/account/1150/active', { active: false, version: 99 })).json.code).toBe('record.version_conflict');
    });
  });

  it('AC6 fix1: the opening-balance account picker leaves out 3300 (the year-end close owns it) and 3900', async () => {
    const ob = (await call('GET', '/accounting/journal-accounts?for=OB')).json as unknown as { code: string }[];
    expect(ob.some((a) => a.code === '3300' || a.code === '3900')).toBe(false);
    expect(ob.some((a) => a.code === '3200')).toBe(true);
  });

  describe('an inactive account cannot be picked anywhere new, but old entries keep it', () => {
    it('JV account list, inline-journal list, bank GL binding and the JV guard drop it; the posted entries still show it', async () => {
      await create();
      expect((await setActive('5190', false)).status).toBe(200);
      const jv = (await call('GET', '/accounting/journal-accounts')).json as unknown as { code: string }[];
      const inline = (await call('GET', '/finance/postable-accounts')).json as unknown as { code: string }[];
      expect(jv.some((a) => a.code === '5190')).toBe(false);
      expect(inline.some((a) => a.code === '5190')).toBe(false);
      expect(jv.some((a) => a.code === '5120')).toBe(true);
      const st = loadState();
      expect(jvAccountProblem(st, 'co-vat', [{ id: 'l1', accountCode: '5190', debit: '1.00', credit: '0.00' } as unknown as DocLine])).toMatchObject({ code: 'ledger.account_invalid' });
      // an inline journal on a bank line refuses it as well
      const line = st.bankLines.find((l) => l.companyId === 'co-vat' && l.status === 'unmatched')!;
      expect(() => post(st, 'co-vat', line.id, { accountCode: '5190' }, { kind: 'user', id: 'u-1', name: 'x' })).toThrow(/ปิดใช้งาน/);
      // the bank GL binding: a cash/bank account that is inactive is not offered
      const gl = (await call('GET', '/finance/bank-gl-accounts')).json as unknown as { code: string }[];
      expect(gl.length).toBeGreaterThan(0);
      withState((s) => { s.accounts.find((a) => a.companyId === 'co-vat' && a.code === '1123')!.active = false; });
      const gl2 = (await call('GET', '/finance/bank-gl-accounts')).json as unknown as { code: string }[];
      expect(gl2.some((a) => a.code === '1123')).toBe(false);
      expect(gl.some((a) => a.code === '1123')).toBe(true);
      // an old entry keeps showing the deactivated account
      const rows = (await list()).items;
      expect(rows.find((r) => r.code === '5190')!.active).toBe(false);
      expect(checkInvariants(loadState())).toEqual([]);
    });
  });

  it('permissions: reading needs ledger.read, writing ledger.coa.manage (the operator is forbidden)', async () => {
    setSettings({ companyKey: 'vat', role: 'operator', screenState: 'normal' });
    expect((await call('GET', '/records/account')).status).toBe(403);
    setSettings({ companyKey: 'vat', role: 'admin', screenState: 'normal' });
    expect((await call('POST', '/records/account', valid)).status).toBe(403);
  });
});
