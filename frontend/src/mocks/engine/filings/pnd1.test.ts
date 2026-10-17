import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { USER as me } from '../../fixtures/documents';
import { PERMISSIONS_BY_ROLE } from '../../permissions';
import { setSettings } from '../../settings';
import { buildSeedState, resetState, type MockState } from '../../store';
import { testServer } from '../../test-server';
import { importStatement, utf8Base64 } from '../bank-import';
import { cancel, createDraft, issue, revise } from '../commands';
import { checkInvariants } from '../invariants';
import { derivedLocks } from '../locks';
import { toSatang } from '../money';
import { payRun, unpayRun } from '../payroll';
import { glBalance, payTax, reverseTaxPayment, taxPaymentLines } from '../reconcile';
import { KBIZ_OCT_NAME, kbizCsv } from '../../fixtures/statements/kbiz-2026-10.csv';
import { KBANK_ACCOUNT_NO, KBANK_SEP_CLOSING, withBalances } from '../../fixtures/statements/kplus-2026-09';
import { exportFilingText, finalizeFiling, getFiling } from './index';
import { formCatalogue } from '../reports/tax-summary';
import { unfiledForms } from './index';
import { deriveRows, runsOf } from './pnd1';

// PY3 rulings 1 - 4 and 7 for the ภ.ง.ด.1 (and the payment of the สปส.1-10, which shares the path).
const CO = 'co-vat';
let st: MockState;
beforeAll(() => testServer.listen({ onUnhandledFrame: 'error' }));
afterAll(() => testServer.close());
beforeEach(() => { localStorage.clear(); resetState(); setSettings({ companyKey: 'vat', role: 'accountant', screenState: 'normal' }); st = buildSeedState(); });
const sat = (m: string) => toSatang(m);
const err = (fn: () => unknown): { status?: number; code?: string; title?: string } => { try { fn(); } catch (e) { return e as { code?: string }; } return {}; };
const doc = (id: string) => st.docs.find((d) => d.id === id)!;
const fileSep = (form: 'PND1' | 'SSO1-10' = 'PND1', co = CO) => finalizeFiling(st, co, form, '2026-09', getFiling(st, co, form, '2026-09').version, me);
const found = (re: RegExp) => checkInvariants(st).some((m) => re.test(m));
const filing = (form: string, period: string) => st.filings.find((f) => f.companyId === CO && f.form === form && f.period === period)!;

describe('ruling 1: the period is the month of the run\'s PAY DATE; an unpaid issued run counts', () => {
  it('September\'s ภ.ง.ด.1 takes both September runs, paid or not, and not August\'s paid run', () => {
    const m = getFiling(st, CO, 'PND1', '2026-09');
    expect(runsOf(st, CO, '2026-09').map((d) => d.id)).toEqual(['pr-2026-09', 'pr-bonus-09']);
    expect(doc('pr-2026-09').status).toBe('issued'); // unpaid
    expect(m.attachment!.rows.map((r) => r.name)).toHaveLength(4); // emp-01, 02, 03, 05
    expect(m.boxes.find((b) => b.code === 'payees')!.amount).toBe('4');
  });
  it('the payment date of the run (PY2) moves nothing: paying September\'s run in October, or August\'s in September, keeps the months', () => {
    const before = JSON.stringify(getFiling(st, CO, 'PND1', '2026-09').boxes);
    payRun(st, CO, 'pr-bonus-09', { accountId: 'ba-kbank', date: '2026-10-14', version: doc('pr-bonus-09').version }, me);
    expect(JSON.stringify(getFiling(st, CO, 'PND1', '2026-09').boxes)).toBe(before);
    expect(getFiling(st, CO, 'PND1', '2026-10').boxes.find((b) => b.code === 'income')!.amount).toBe('0.00'); // October has no run
  });
});

describe('the seed and the model', () => {
  it('August is filed (ภ.ง.ด.1 and สปส.1-10), September is a draft; the invariants are clean', () => {
    expect(getFiling(st, CO, 'PND1', '2026-08')).toMatchObject({ status: 'finalized', finalizedBy: me.name });
    expect(getFiling(st, CO, 'SSO1-10', '2026-08').status).toBe('finalized');
    expect(getFiling(st, CO, 'PND1', '2026-09')).toMatchObject({ status: 'draft', blockers: [] });
    expect(checkInvariants(st)).toEqual([]);
  });
  it('every row is the sum of the employee\'s stored slips: income, PIT and the SSO they paid', () => {
    const rows = filing('PND1', '2026-08').payroll!.rows;
    for (const r of rows) {
      const slips = runsOf(st, CO, '2026-08').flatMap((d) => d.payroll!.slips).filter((s) => s.employeeId === r.employeeId);
      expect(sat(r.income)).toBe(slips.reduce((n, s) => n + sat(s.gross), 0));
      expect(sat(r.pit!)).toBe(slips.reduce((n, s) => n + sat(s.pit), 0));
      expect(sat(r.sso)).toBe(slips.reduce((n, s) => n + sat(s.sso), 0));
    }
    expect(filing('PND1', '2026-08').payroll!.runs).toEqual([{ id: 'pr-2026-08', number: doc('pr-2026-08').number, revision: 0 }]);
  });
  it('an employee in two runs of the month is ONE row (the bonus run adds to the salary run)', () => {
    const rows = deriveRows(runsOf(st, CO, '2026-09'), 'pnd1'), e1 = rows.filter((r) => r.employeeId === 'emp-01');
    expect(e1).toHaveLength(1);
    expect(sat(e1[0].income)).toBe(sat(doc('pr-2026-09').payroll!.slips.find((s) => s.employeeId === 'emp-01')!.gross) + sat(doc('pr-bonus-09').payroll!.slips.find((s) => s.employeeId === 'emp-01')!.gross));
  });
});

describe('ruling 4: tie-outs and blockers', () => {
  it('Σ PIT is the month\'s 2153 credit movement from the payroll runs: zero difference, and no other movement', () => {
    for (const p of ['2026-08', '2026-09']) {
      const t = getFiling(st, CO, 'PND1', p).tieOuts;
      expect(t.map((x) => [x.labelKey, x.diff])).toEqual([['filing.tie.pnd1Gl', '0.00'], ['filing.tie.pnd1Other', '0.00']]);
    }
  });
  it('another 2153 movement in the month is its own line (amber), never folded into the first; paying last month\'s return is not a movement', () => {
    const line = { accountCode: '2153', accountName: 'x', debit: '0.00', credit: '40.00', rule: 'manual' };
    st.bankJournals.push({ id: 'bj-x', companyId: CO, accountId: 'ba-kbank', kind: 'fee', label: 'x', entries: [{ date: '2026-09-10', kind: 'original', postedAt: '2026-09-10T00:00:00.000Z', lines: [line, { ...line, accountCode: '1121', debit: '40.00', credit: '0.00' }] }] });
    const t = getFiling(st, CO, 'PND1', '2026-09').tieOuts;
    expect(t[0]).toMatchObject({ labelKey: 'filing.tie.pnd1Gl', diff: '0.00' });
    expect(t[1]).toMatchObject({ labelKey: 'filing.tie.pnd1Other', left: '40.00', right: '0.00', diff: '40.00' });
  });
  it('an employee without a national id is a blocker that names them; a draft run of the month is a warning, not a blocker', () => {
    const s = doc('pr-2026-09').payroll!.slips.find((x) => x.employeeId === 'emp-03')!;
    s.employee.nationalId = '';
    const d = createDraft(st, CO, 'PR', { header: { documentDate: '2026-09-20', reference: 'ร่างเดือนกันยายน' }, lines: [] }, me, 'k-draft');
    const m = getFiling(st, CO, 'PND1', '2026-09');
    expect(m.blockers.find((b) => b.code === 'employee_nid')).toMatchObject({ labelTh: expect.stringContaining('มาลี'), href: '/payroll/employees/emp-03' });
    expect(m.blockers.filter((b) => b.code !== 'employee_nid')).toEqual([]);
    expect(m.warnings.join(' ')).toContain('ร่างเดือนกันยายน');
    expect(d.id).toBeTruthy();
    expect(err(() => fileSep()).code).toBe('filing.blocked');
  });
  it('September cannot be filed before August; a stale preview is refused', () => {
    const aug = filing('PND1', '2026-08');
    aug.period = '2026-10'; // the chain now starts at October: September is before it
    expect(getFiling(st, CO, 'PND1', '2026-09').blockers.map((b) => b.code)).toContain('before_chain');
    aug.period = '2026-08';
    expect(getFiling(st, CO, 'PND1', '2026-09').blockers).toEqual([]);
    expect(err(() => finalizeFiling(st, CO, 'PND1', '2026-09', 1, me)).code).toBe('filing.stale');
  });
});

describe('ruling 2: frozen at finalize - nothing is re-derived afterwards', () => {
  it('a later edit of the employee, the company or the table moves nothing of a filed return', () => {
    const before = JSON.stringify(getFiling(st, CO, 'PND1', '2026-08'));
    st.parties.find((p) => p.id === 'emp-01')!.name = 'ชื่อใหม่'; st.parties.find((p) => p.id === 'emp-01')!.taxId = '1234567890123';
    st.companies.find((c) => c.id === CO)!.legalNameTh = 'บริษัท เปลี่ยนชื่อ จำกัด';
    expect(JSON.stringify(getFiling(st, CO, 'PND1', '2026-08'))).toBe(before);
    expect(checkInvariants(st)).toEqual([]);
  });
  const cases: [string, (s: MockState) => void, RegExp][] = [
    ['a row\'s income edited', (s) => { s.filings.find((f) => f.form === 'PND1' && f.period === '2026-09')!.payroll!.rows[0].income = '1.00'; }, /row emp-01 income/],
    ['a row\'s PIT edited', (s) => { s.filings.find((f) => f.form === 'PND1' && f.period === '2026-09')!.payroll!.rows[1].pit = '1.00'; }, /row emp-02 pit/],
    ['a row\'s SSO edited', (s) => { s.filings.find((f) => f.form === 'PND1' && f.period === '2026-09')!.payroll!.rows[2].sso = '1.00'; }, /row emp-03 sso/],
    ['a row\'s employer SSO edited', (s) => { s.filings.find((f) => f.form === 'PND1' && f.period === '2026-09')!.payroll!.rows[2].ssoEmployer = '1.00'; }, /row emp-03 ssoEmployer/],
    ['a row\'s national id edited', (s) => { s.filings.find((f) => f.form === 'PND1' && f.period === '2026-09')!.payroll!.rows[0].nationalId = '1100200300400'; }, /row emp-01 nationalId/],
    ['a row\'s name edited', (s) => { s.filings.find((f) => f.form === 'PND1' && f.period === '2026-09')!.payroll!.rows[0].name = 'อื่น'; }, /row emp-01 name/],
    ['a row dropped', (s) => { s.filings.find((f) => f.form === 'PND1' && f.period === '2026-09')!.payroll!.rows.pop(); }, /stored rows are 3/],
    ['the stored slip of a stored run edited (its figures move away from the filed row)', (s) => { s.docs.find((d) => d.id === 'pr-2026-09')!.payroll!.slips[0].gross = '1.00'; }, /row emp-01 income/],
    ['a stored slip\'s national id edited (anchored to the filing)', (s) => { s.docs.find((d) => d.id === 'pr-bonus-09')!.payroll!.slips[0].employee.nationalId = '1100200300400'; }, /row emp-01 nationalId/],
    ['the run\'s revision changed after filing', (s) => { s.docs.find((d) => d.id === 'pr-bonus-09')!.revision = 1; }, /revision/],
    ['a taken run dropped from the snapshot', (s) => { s.filings.find((f) => f.form === 'PND1' && f.period === '2026-09')!.payroll!.runs.pop(); }, /run pr-bonus-09 is missing/],
    ['a taken run cancelled behind the lock', (s) => { s.docs.find((d) => d.id === 'pr-bonus-09')!.status = 'cancelled'; }, /pr-bonus-09 is listed but is cancelled/],
    ['the stored income box edited', (s) => { s.filings.find((f) => f.form === 'PND1' && f.period === '2026-09')!.boxes.find((b) => b.code === 'income')!.amount = '1.00'; }, /boxes are not Σ/],
    ['the stored tax box edited', (s) => { s.filings.find((f) => f.form === 'PND1' && f.period === '2026-09')!.boxes.find((b) => b.code === 'tax')!.amount = '1.00'; }, /boxes are not Σ/],
  ];
  it.each(cases)('single fault: %s is caught by an invariant', (_n, tamper, re) => {
    fileSep(); fileSep('SSO1-10');
    expect(checkInvariants(st)).toEqual([]);
    tamper(st);
    expect(found(re), checkInvariants(st).join('\n')).toBe(true);
  });
});

describe('ruling 3: the filing lock', () => {
  it('a run a finalized ภ.ง.ด.1 took cannot be revised or cancelled (filing.locked, exit: the next run\'s adjustment lines); a new run cannot enter the filed month', () => {
    fileSep();
    const v = doc('pr-bonus-09').version, body = { header: doc('pr-bonus-09').header, lines: doc('pr-bonus-09').lines };
    for (const f of [() => revise(st, 'pr-bonus-09', body, v, 'x', me), () => cancel(st, 'pr-bonus-09', v, 'OTHER', 'x', me)]) {
      const x = err(f);
      expect(x).toMatchObject({ status: 409, code: 'filing.locked' });
      expect(x.title).toContain('แก้ไขในรอบถัดไป (รายได้อื่น / รายการหักอื่น)');
    }
    const lock = derivedLocks(st, doc('pr-bonus-09')).find((l) => l.kind === 'filing')!;
    expect(lock.reason).toContain('ภ.ง.ด.1');
    expect(lock.exits.join(' ')).toContain('แก้ไขในรอบถัดไป');
    const d = createDraft(st, CO, 'PR', { header: { documentDate: '2026-09-30', reference: 'ใหม่' }, lines: [{ id: 'n1', description: '', qty: '1', unit: '', unitPrice: '0.00', taxCode: 'EX', employeeId: 'emp-03', pay: { salary: '22000.00' } }] }, me, 'k-new');
    expect(err(() => issue(st, d.id, d.version, me))).toMatchObject({ status: 409, code: 'filing.period_filed' });
    expect(checkInvariants(st)).toEqual([]);
  });
  it('the สปส.1-10 locks the runs it took on its own (the ภ.ง.ด.1 of the month not filed)', () => {
    fileSep('SSO1-10');
    expect(err(() => cancel(st, 'pr-bonus-09', doc('pr-bonus-09').version, 'OTHER', 'x', me))).toMatchObject({ code: 'filing.locked' });
    expect(derivedLocks(st, doc('pr-bonus-09')).find((l) => l.kind === 'filing')!.reason).toContain('สปส.1-10');
  });
  it('pay and unpay of a filed run stay allowed: cash only, no figure moves', () => {
    fileSep();
    const before = JSON.stringify(filing('PND1', '2026-09'));
    payRun(st, CO, 'pr-bonus-09', { accountId: 'ba-kbank', date: '2026-10-14', version: doc('pr-bonus-09').version }, me);
    unpayRun(st, CO, 'pr-bonus-09', { reason: 'จ่ายผิดบัญชี', version: doc('pr-bonus-09').version }, me);
    expect(JSON.stringify(filing('PND1', '2026-09'))).toBe(before);
    expect(checkInvariants(st)).toEqual([]);
  });
  it('a month that is not filed stays free: the October run is not blocked by September\'s return', () => {
    fileSep();
    expect(err(() => cancel(st, 'pr-2026-10', doc('pr-2026-10').version, 'OTHER', 'x', me)).code).not.toBe('filing.locked'); // a draft run
  });
});

// ---------------------------------------------------------------- ruling 7: paying a ภ.ง.ด.1 and a สปส.1-10 from a bank line
function statement(lines: [date: string, description: string, amount: string][]) {
  const content = utf8Base64(kbizCsv({ accountNo: KBANK_ACCOUNT_NO, accountName: 'บริษัท ตัวอย่าง จำกัด', from: '2026-10-01', opening: KBANK_SEP_CLOSING, lines: withBalances(KBANK_SEP_CLOSING, lines) }));
  const imp = importStatement(st, CO, 'ba-kbank', { fileName: KBIZ_OCT_NAME, format: 'kbiz-csv', content }, me);
  return st.bankLines.filter((l) => l.importId === imp.id);
}
const bal = (code: string) => glBalance(st, CO, code, '2099-12-31'); // debit - credit, satang
const jnl = (id: string) => st.bankJournals.find((j) => j.id === id)!;
const PND1_AUG = { form: 'PND1' as const, period: '2026-08' }, SSO_AUG = { form: 'SSO1-10' as const, period: '2026-08' };

describe('ruling 7: pay a ภ.ง.ด.1 (Dr 2153) and a สปส.1-10 (Dr 2160) from a bank line', () => {
  it('the due is the PIT (ภ.ง.ด.1) and employee + employer (สปส.1-10); the candidate lines list them', () => {
    expect(getFiling(st, CO, 'PND1', '2026-08').payment).toMatchObject({ due: '2436.50', status: 'unpaid' });
    expect(getFiling(st, CO, 'SSO1-10', '2026-08').payment).toMatchObject({ due: '7000.00', status: 'unpaid' });
    statement([['2026-10-13', 'ภาษีเงินเดือน', '-2436.50'], ['2026-10-14', 'ประกันสังคม', '-7000.00']]);
    expect(taxPaymentLines(st, CO, 'PND1', '2026-08').lines[0].amount).toBe('-2436.50');
    expect(taxPaymentLines(st, CO, 'SSO1-10', '2026-08').lines[0].amount).toBe('-7000.00');
  });
  it('pays the exact PIT: Dr 2153 / Cr bank, the payable clears by exactly the return; the return reads paid; the invariants hold', () => {
    const [line] = statement([['2026-10-13', 'ภาษีเงินเดือน ส.ค.', '-2436.50']]);
    const b0 = bal('2153');
    const out = payTax(st, CO, line.id, PND1_AUG, me);
    expect(jnl(out.journalId!).entries[0].lines.map((l) => [l.accountCode, l.debit, l.credit])).toEqual([['2153', '2436.50', '0.00'], ['1121', '0.00', '2436.50']]);
    expect(bal('2153') - b0).toBe(243650);
    expect(getFiling(st, CO, 'PND1', '2026-08').payment).toMatchObject({ status: 'paid', paidOn: '2026-10-13' });
    expect(err(() => payTax(st, CO, line.id, PND1_AUG, me)).code).toBeTruthy(); // the line is posted
    expect(checkInvariants(st)).toEqual([]);
  });
  it('pays a สปส.1-10 with the employer share: Dr 2160 for the total; typed extras (a fee / เงินเพิ่ม) go to a free account, never a control account; the amount must be exact', () => {
    const [bad, line] = statement([['2026-10-13', 'ผิดยอด', '-6000.00'], ['2026-10-14', 'ประกันสังคม + เงินเพิ่ม', '-7100.00']]);
    expect(err(() => payTax(st, CO, bad.id, SSO_AUG, me)).code).toBe('tax_payment.amount');
    expect(err(() => payTax(st, CO, line.id, { ...SSO_AUG, extras: [{ accountCode: '2160', amount: '100.00' }] }, me)).code).toBe('ledger.control_account');
    expect(err(() => payTax(st, CO, line.id, { ...SSO_AUG, extras: [{ accountCode: '2153', amount: '100.00' }] }, me)).code).toBe('ledger.control_account');
    const b0 = bal('2160');
    const out = payTax(st, CO, line.id, { ...SSO_AUG, extras: [{ accountCode: '5200', amount: '100.00' }] }, me);
    expect(jnl(out.journalId!).entries[0].lines.map((l) => [l.accountCode, l.debit, l.credit])).toEqual([['2160', '7000.00', '0.00'], ['5200', '100.00', '0.00'], ['1121', '0.00', '7100.00']]);
    expect(bal('2160') - b0).toBe(700000);
    expect(getFiling(st, CO, 'SSO1-10', '2026-08').payment).toMatchObject({ status: 'paid', extras: '100.00' });
    expect(checkInvariants(st)).toEqual([]);
  });
  it('one live payment per return; a draft or a ภ.ง.ด.1ก cannot be paid; the reversal restores the payable and the line', () => {
    const [a, b] = statement([['2026-10-13', 'ภาษี', '-2436.50'], ['2026-10-14', 'ภาษีอีกครั้ง', '-2436.50']]);
    expect(err(() => payTax(st, CO, a.id, { form: 'PND1', period: '2026-09' }, me)).code).toBe('tax_payment.not_finalized');
    expect(err(() => payTax(st, CO, a.id, { form: 'PND1A', period: '2026-08' }, me)).code).toBe('tax_payment.not_supported');
    const b0 = bal('2153');
    const out = payTax(st, CO, a.id, PND1_AUG, me);
    expect(err(() => payTax(st, CO, b.id, PND1_AUG, me)).code).toBe('tax_payment.already_paid');
    reverseTaxPayment(st, CO, out.journalId!, me, 'จ่ายผิด');
    expect(bal('2153')).toBe(b0);
    expect(st.bankLines.find((l) => l.id === a.id)!.status).toBe('unmatched');
    payTax(st, CO, b.id, PND1_AUG, me); // paid again from the other line
    expect(checkInvariants(st)).toEqual([]);
  });
  it('single-fault tampers: an overpayment consistent on every figure, and a payment of a return that is no longer there', () => {
    const [a] = statement([['2026-10-13', 'ภาษี', '-2436.50']]);
    const j = jnl(payTax(st, CO, a.id, PND1_AUG, me).journalId!);
    j.filing!.amount = '2436.51'; j.entries[0].lines[0].debit = '2436.51'; j.entries[0].lines[1].credit = '2436.51';
    expect(found(/tax payment bj-\d+/)).toBe(true);
  });
  it('the payable account of the payment is the one the run posted to (2153 / 2160 are PitPayable / SsoPayable)', () => {
    const credit = (code: string) => runsOf(st, CO, '2026-08').flatMap((d) => st.journals.find((x) => x.docId === d.id)!.preview.entries.flatMap((e) => e.lines.filter((l) => l.accountCode === code))).reduce((n, l) => n + sat(l.credit), 0);
    const f = (form: string) => filing(form, '2026-08').payroll!.rows;
    expect(credit('2153')).toBe(f('PND1').reduce((n, r) => n + sat(r.pit!), 0)); // the rule is the equality with Σ PIT / Σ (sso + employer sso), not a seed number
    expect(credit('2160')).toBe(f('SSO1-10').reduce((n, r) => n + sat(r.sso) + sat(r.ssoEmployer), 0));
  });
});

describe('the RD Prep text of a ภ.ง.ด.1 and the wire', () => {
  it('a draft has no file; the filed one lists the employees from the stored rows', () => {
    expect(err(() => exportFilingText(st, CO, 'PND1', '2026-09')).code).toBe('filing.not_finalized');
    const lines = exportFilingText(st, CO, 'PND1', '2026-08').split('\r\n');
    expect(lines[0]).toMatch(/^H\|PND1\|0105569012345\|00000\|256908\|/);
    expect(lines.filter((l) => l.startsWith('D|'))).toHaveLength(4);
    expect(lines.find((l) => l.startsWith('T|'))).toBe('T|4|201200.00|2436.50');
  });
  const call = (p: string) => fetch(`http://localhost/bff/v1${p}`);
  it('read with payroll.read: the accountant reads, the operator and the admin are forbidden (naming payroll.read); the other company reads its own', async () => {
    expect(PERMISSIONS_BY_ROLE.accountant).toContain('payroll.read');
    expect((await call('/filings/PND1/2026-08')).status).toBe(200);
    for (const role of ['operator', 'admin'] as const) {
      setSettings({ companyKey: 'vat', role, screenState: 'normal' });
      const r = await call('/filings/PND1/2026-08');
      expect(r.status, role).toBe(403);
      expect(JSON.stringify(await r.json())).toContain('payroll.read');
    }
    setSettings({ companyKey: 'nonvat', role: 'accountant', screenState: 'normal' });
    const other = (await (await call('/filings/PND1/2026-09')).json()) as { boxes: { code: string; amount: string }[] };
    expect(other.boxes.find((b) => b.code === 'payees')!.amount).toBe('3'); // nemp-01..03, not the VAT company's four
  });
});

describe('PY3a M1: the snapshot fingerprint covers what nothing else re-derives (company as filed, due date, who and when)', () => {
  const cases: [string, (s: MockState) => void][] = [
    ['the SSO account as filed replaced by another valid number', (s) => { s.filings.find((f) => f.form === 'SSO1-10' && f.period === '2026-08')!.company.ssoEmployerAccountNo = '9999999999'; }],
    ['the company name as filed edited', (s) => { s.filings.find((f) => f.form === 'PND1' && f.period === '2026-08')!.company.legalNameTh = 'อื่น'; }],
    ['the branch as filed edited', (s) => { s.filings.find((f) => f.form === 'PND1' && f.period === '2026-08')!.company.branchCode = '00001'; }],
    ['the due date edited', (s) => { s.filings.find((f) => f.form === 'SSO1-10' && f.period === '2026-08')!.dueDate = '2026-09-30'; }],
    ['who finalized edited', (s) => { s.filings.find((f) => f.form === 'PND3' && f.period === '2026-08')!.finalizedBy = 'ใครสักคน'; }],
  ];
  it('the untouched seed is clean and every filing carries its fingerprint', () => {
    expect(checkInvariants(st)).toEqual([]);
    expect(st.filings.every((f) => typeof f.fp === 'number')).toBe(true);
  });
  it.each(cases)('single fault: %s', (_n, tamper) => {
    tamper(st);
    expect(found(/fingerprint/), checkInvariants(st).join('\n')).toBe(true);
  });
  it('m-tie: a stored tie-out is checked for its arithmetic only (diff = left - right); the books moving after filing is not a fault', () => {
    filing('PND1', '2026-08').tieOuts[1].right = '5.00';
    expect(found(/tie-out filing.tie.pnd1Other diff .* is not left - right/)).toBe(true);
    resetState(); st = buildSeedState();
    st.bankJournals.push({ id: 'bj-x', companyId: CO, accountId: 'ba-kbank', kind: 'fee', label: 'x', entries: [{ date: '2026-08-10', kind: 'original', postedAt: '2026-08-10T00:00:00.000Z', lines: [{ accountCode: '2153', accountName: 'x', debit: '0.00', credit: '9.00', rule: 'm' }, { accountCode: '1121', accountName: 'x', debit: '9.00', credit: '0.00', rule: 'm' }] }] });
    expect(checkInvariants(st).filter((x) => /tie-out/.test(x))).toEqual([]);
  });
});

describe('PY3a m-close / m-forms', () => {
  it('the period close lists the unfiled ภ.ง.ด.1 and สปส.1-10 of a month that has issued runs, and not once they are filed', () => {
    expect(unfiledForms(st, CO, '2026-09')).toEqual(expect.arrayContaining(['PND1', 'SSO1-10']));
    expect(unfiledForms(st, CO, '2026-08')).not.toContain('PND1');
    fileSep(); fileSep('SSO1-10');
    expect(unfiledForms(st, CO, '2026-09')).not.toContain('PND1');
    expect(unfiledForms(st, CO, '2026-10')).not.toContain('PND1'); // October has only a draft run
  });
  it('the /tax/forms history names payroll forms in Thai and hides them from a user without payroll.read', () => {
    const rows = (can: boolean) => formCatalogue(st, CO, can).history.filter((h) => ['PND1', 'SSO1-10'].includes(h.form));
    expect(rows(true).map((h) => h.nameTh).sort()).toEqual(['ภ.ง.ด.1', 'สปส.1-10']);
    expect(rows(false)).toEqual([]);
  });
});
