import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PaperModel } from '@/domain/types';
import { USER as me } from '../../fixtures/documents';
import { setSettings } from '../../settings';
import { buildSeedState, resetState, type MockState } from '../../store';
import { testServer } from '../../test-server';
import { createDraft, issue } from '../commands';
import { checkInvariants } from '../invariants';
import { toSatang } from '../money';
import { exportFilingText, filingHistory, finalizeFiling, getFiling } from './index';
import { employeeCertificates, yearRows } from './pnd1a';

// PY3 rulings 5 and 8: ภ.ง.ด.1ก = the opening-balance payroll YTD of that year + Σ the year's FINALIZED ภ.ง.ด.1 months; the annual 50 ทวิ for employees comes from its stored rows.
const CO = 'co-vat', NV = 'co-nonvat';
let st: MockState;
beforeAll(() => testServer.listen({ onUnhandledFrame: 'error' }));
afterAll(() => testServer.close());
beforeEach(() => { localStorage.clear(); resetState(); setSettings({ companyKey: 'vat', role: 'accountant', screenState: 'normal' }); st = buildSeedState(); });
const sat = (m: string) => toSatang(m);
const err = (fn: () => unknown): { status?: number; code?: string; title?: string } => { try { fn(); } catch (e) { return e as { code?: string }; } return {}; };
const a1 = (co: string, y: string) => getFiling(st, co, 'PND1A', y);
const file1a = (co: string, y: string) => finalizeFiling(st, co, 'PND1A', y, a1(co, y).version, me);
const file1 = (co: string, p: string) => finalizeFiling(st, co, 'PND1', p, getFiling(st, co, 'PND1', p).version, me);
const stored = (co: string, y: string) => st.filings.find((f) => f.companyId === co && f.form === 'PND1A' && f.period === y)!;
const found = (re: RegExp) => checkInvariants(st).some((m) => re.test(m));
const obDoc = () => ({ id: 'ob-t', companyId: CO, type: 'OB', status: 'issued', number: 'OB-2026-0001', header: { documentDate: '2026-06-30' }, lines: [], locks: [], totals: { total: '0.00' }, opening: { openItems: [], assets: [], bank: [], payrollYtd: [{ employeeId: 'emp-04', income: '50000.00', pit: '500.00', sso: '1750.00' }] } }) as never;
const boxOf = (m: { boxes: { code: string; amount: string }[] }, c: string) => sat(m.boxes.find((b) => b.code === c)!.amount);

describe('ruling 5: the opening part (AC3) + the finalized months', () => {
  it('the non-VAT company\'s 2025: only the opening balance (nob-1, dated 2025-12-31) - pre-go-live, labelled; finalizes; the invariants hold', () => {
    const m = a1(NV, '2025');
    expect(m.attachment!.rows.map((r) => [r.name, r.obIncome, r.income, r.tax, r.sso])).toEqual([['บุญมา ทำดี', '180000.00', '180000.00', '2400.00', '9000.00'], ['สายใจ รักงาน', '150000.00', '150000.00', '1200.00', '9000.00']].map((r) => expect.arrayContaining(r)));
    expect(m.attachment!.columns.find((c) => c.key === 'obIncome')!.labelTh).toContain('ก่อนใช้ระบบ');
    expect(m.blockers).toEqual([]);
    file1a(NV, '2025');
    expect(stored(NV, '2025').payroll).toMatchObject({ runs: [], months: [] });
    expect(stored(NV, '2025').payroll!.rows.every((r) => !!r.ob)).toBe(true);
    expect(checkInvariants(st)).toEqual([]);
  });
  it('an opening balance of ANOTHER year says nothing about this year: 2026 of the same company takes no opening part', () => {
    const m = a1(NV, '2026');
    expect(m.attachment!.rows.map((r) => r.obIncome)).toEqual(m.attachment!.rows.map(() => '-'));
  });
  it('the VAT company\'s 2026: blocked while a month with an issued run is not filed (names the month, links to it); clear once September is filed', () => {
    const m = a1(CO, '2026');
    expect(m.blockers).toEqual([expect.objectContaining({ code: 'pnd1_open', labelTh: expect.stringContaining('ก.ย. 2569'), href: '/payroll/filings?tab=pnd1&period=2026-09' })]);
    expect(m.warnings.join(' ')).toContain('ยังไม่สิ้นปี');
    expect(err(() => file1a(CO, '2026')).code).toBe('filing.blocked');
    file1(CO, '2026-09');
    expect(a1(CO, '2026').blockers).toEqual([]);
  });
  it('1ก Σ = opening part + Σ the finalized ภ.ง.ด.1 months: income, PIT and SSO per employee, and in the boxes; the tie-out is zero', () => {
    file1(CO, '2026-09');
    const f = file1a(CO, '2026');
    expect(f.status).toBe('finalized');
    const months = ['2026-08', '2026-09'].map((p) => getFiling(st, CO, 'PND1', p));
    for (const c of ['income', 'tax']) expect(boxOf(f, c)).toBe(months.reduce((n, m) => n + boxOf(m, c), 0));
    const rows = stored(CO, '2026').payroll!.rows;
    expect(rows.map((r) => r.employeeId)).toEqual(['emp-01', 'emp-02', 'emp-03', 'emp-05']);
    for (const r of rows) {
      const mine = ['2026-08', '2026-09'].flatMap((p) => st.filings.find((x) => x.form === 'PND1' && x.period === p)!.payroll!.rows.filter((x) => x.employeeId === r.employeeId));
      expect(sat(r.income)).toBe(mine.reduce((n, x) => n + sat(x.income), 0));
      expect(sat(r.pit!)).toBe(mine.reduce((n, x) => n + sat(x.pit!), 0));
      expect(sat(r.sso)).toBe(mine.reduce((n, x) => n + sat(x.sso), 0));
    }
    expect(stored(CO, '2026').payroll!.months).toEqual(['2026-08', '2026-09']);
    expect(f.tieOuts).toEqual([expect.objectContaining({ labelKey: 'filing.tie.pnd1aMonths', diff: '0.00' })]);
    expect(checkInvariants(st)).toEqual([]);
  });
  it('yearRows: an employee with an opening part AND months = opening + Σ months; one with only an opening part keeps it (name and id from the opening part)', () => {
    const month = (p: string, income: string) => ({ period: p, payroll: { runs: [], rows: [{ employeeId: 'e1', name: 'ก', nationalId: '1', income, pit: '10.00', sso: '5.00', ssoEmployer: '5.00' }] } }) as never;
    const ob = new Map([['e1', { income: 60000000, pit: 900000, sso: 437500, name: 'เก่า', nationalId: '0' }], ['e2', { income: 100, pit: 0, sso: 0, name: 'ข', nationalId: '2' }]]);
    expect(yearRows([month('2026-08', '1000.00'), month('2026-09', '2000.00')], ob)).toEqual([
      { employeeId: 'e1', name: 'ก', nationalId: '1', income: '603000.00', pit: '9020.00', sso: '4385.00', ssoEmployer: '10.00', ob: { income: '600000.00', pit: '9000.00', sso: '4375.00' } },
      { employeeId: 'e2', name: 'ข', nationalId: '2', income: '1.00', pit: '0.00', sso: '0.00', ssoEmployer: '0.00', ob: { income: '1.00', pit: '0.00', sso: '0.00' } }]);
  });
  it('an employee with an opening part only (emp-04, no slips) is a row of the VAT company\'s 2026 next to the months', () => {
    st.docs.push(obDoc());
    file1(CO, '2026-09');
    const m = a1(CO, '2026');
    expect(m.attachment!.rows.map((r) => [r.name.slice(0, 4), r.obIncome])).toContainEqual(['ธนา ', '50000.00']);
    file1a(CO, '2026');
    expect(checkInvariants(st).filter((x) => /filing PND1A/.test(x))).toEqual([]);
  });
  it('a run cannot be issued into a year whose ภ.ง.ด.1ก is filed', () => {
    file1(CO, '2026-09'); file1a(CO, '2026');
    const d = createDraft(st, CO, 'PR', { header: { documentDate: '2026-10-14', reference: 'ต.ค.' }, lines: [{ id: 'n1', description: '', qty: '1', unit: '', unitPrice: '0.00', taxCode: 'EX', employeeId: 'emp-01', pay: { salary: '120000.00' } }] }, me, 'k-oct');
    expect(err(() => issue(st, d.id, d.version, me))).toMatchObject({ status: 409, code: 'filing.period_filed' });
  });
  it('an employee without a national id blocks; the year with nothing to file has no_documents; the history lists the year and nothing is payable', () => {
    expect(a1(CO, '2025').blockers.map((b) => b.code)).toEqual(['no_documents']);
    file1a(NV, '2025');
    expect(filingHistory(st, NV, 'PND1A')).toEqual([expect.objectContaining({ form: 'PND1A', period: '2025', net: '3600.00' })]);
    expect(filingHistory(st, NV, 'PND1A')[0].payment).toBeUndefined();
    expect(getFiling(st, NV, 'PND1A', '2025').payment).toBeUndefined();
    expect(exportFilingText(st, NV, 'PND1A', '2025').split('\r\n')[0]).toMatch(/^H\|PND1A\|/);
  });
});

describe('ruling 5 invariant: single-fault tampers of a filed ภ.ง.ด.1ก', () => {
  const setup = () => { st.docs.push(obDoc()); file1(CO, '2026-09'); file1a(CO, '2026'); };
  const mine = () => checkInvariants(st).filter((x) => /filing PND1A/.test(x));
  const cases: [string, (s: MockState) => void, RegExp][] = [
    ['a row\'s income edited', (s) => { s.filings.find((f) => f.form === 'PND1A')!.payroll!.rows[0].income = '1.00'; }, /row emp-01 income/],
    ['a row\'s PIT edited', (s) => { s.filings.find((f) => f.form === 'PND1A')!.payroll!.rows[1].pit = '1.00'; }, /row emp-02 pit/],
    ['a row\'s SSO edited', (s) => { s.filings.find((f) => f.form === 'PND1A')!.payroll!.rows[2].sso = '1.00'; }, /row emp-03 sso/],
    ['the opening part edited (the row no longer adds up)', (s) => { s.filings.find((f) => f.form === 'PND1A')!.payroll!.rows.find((r) => r.ob)!.ob!.income = '1.00'; }, /row emp-04 income/],
    ['a month dropped from the months taken', (s) => { s.filings.find((f) => f.form === 'PND1A')!.payroll!.months!.pop(); }, /it took months/],
    ['a month added that is not finalized', (s) => { s.filings.find((f) => f.form === 'PND1A')!.payroll!.months!.push('2026-10'); }, /it took months/],
    ['a finalized ภ.ง.ด.1 row edited after (the 1ก no longer adds up to its months)', (s) => { s.filings.find((f) => f.form === 'PND1' && f.period === '2026-08')!.payroll!.rows[1].income = '1.00'; }, /PND1A 2026.*row emp-02 income/],
    ['a stored box edited', (s) => { s.filings.find((f) => f.form === 'PND1A')!.boxes.find((b) => b.code === 'sso')!.amount = '1.00'; }, /boxes are not Σ/],
    ['the tie-out edited', (s) => { s.filings.find((f) => f.form === 'PND1A')!.tieOuts[0].right = '1.00'; }, /tie-out/],
    ['a row dropped', (s) => { s.filings.find((f) => f.form === 'PND1A')!.payroll!.rows.pop(); }, /stored rows are/],
  ];
  it.each(cases)('%s is caught', (_n, tamper, re) => {
    setup();
    expect(mine()).toEqual([]);
    tamper(st);
    expect(mine().some((m) => re.test(m)) || found(re), checkInvariants(st).join('\n')).toBe(true);
  });
});

describe('ruling 8: the annual 50 ทวิ for employees comes from the finalized ภ.ง.ด.1ก rows', () => {
  it('not available until the ภ.ง.ด.1ก is finalized; then one certificate per employee: income 40(1), PIT withheld, SSO paid, the ภ.ง.ด.1ก box ticked, the payer as filed', () => {
    expect(err(() => employeeCertificates(st, NV, '2025')).code).toBe('filing.not_finalized');
    file1a(NV, '2025');
    const certs = employeeCertificates(st, NV, '2025');
    expect(certs).toHaveLength(2);
    const rows = stored(NV, '2025').payroll!.rows;
    for (const [i, c] of certs.entries()) {
      expect(c.certificate).toMatchObject({ form: 'PND1A', incomeType: '40(1) เงินเดือน ค่าจ้าง', income: rows[i].income, tax: rows[i].pit, ssoPaid: rows[i].sso, condition: 'withhold' });
      expect(c.buyer).toMatchObject({ name: rows[i].name, taxId: rows[i].nationalId });
      expect(c.seller).toMatchObject({ name: 'บริษัท บ้านต้นข้าว ฟู้ดส์ จำกัด', taxId: '0105569056784' });
      expect(c.totals.total).toBe(rows[i].income);
    }
    expect(new Set(certs.map((c) => c.number)).size).toBe(2);
  });
  it('the payer is the company AS FILED: a later rename moves nothing on the certificate', () => {
    file1a(NV, '2025');
    st.filings.find((f) => f.form === 'PND1A')!.company.legalNameTh = 'บริษัท ที่ยื่นไว้ จำกัด';
    st.companies.find((c) => c.id === NV)!.legalNameTh = 'บริษัท ชื่อใหม่ จำกัด';
    expect(employeeCertificates(st, NV, '2025')[0].seller.name).toBe('บริษัท ที่ยื่นไว้ จำกัด');
  });
  const call = (p: string) => fetch(`http://localhost/bff/v1${p}`);
  it('over the wire: payroll.read reads; the operator is forbidden; another company has none of this company\'s', async () => {
    setSettings({ companyKey: 'nonvat', role: 'accountant', screenState: 'normal' });
    expect((await call('/filings/PND1A/2025/certificates')).status).toBe(409); // not finalized yet
    const model = (await (await call('/filings/PND1A/2025')).json()) as { version: number };
    const fin = await fetch('http://localhost/bff/v1/filings/PND1A/2025/finalize', { method: 'POST', body: JSON.stringify({ version: model.version }), headers: { 'content-type': 'application/json' } });
    expect(fin.status).toBe(200);
    const ok = await call('/filings/PND1A/2025/certificates');
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as PaperModel[]).map((c) => c.buyer.name)).toEqual(['บุญมา ทำดี', 'สายใจ รักงาน']);
    setSettings({ companyKey: 'vat', role: 'accountant', screenState: 'normal' });
    expect((await call('/filings/PND1A/2025/certificates')).status).toBe(409); // the VAT company has not filed its 2025
    setSettings({ companyKey: 'vat', role: 'operator', screenState: 'normal' });
    const f = await call('/filings/PND1A/2025/certificates');
    expect(f.status).toBe(403);
    expect(JSON.stringify(await f.json())).toContain('payroll.read');
  });
});
