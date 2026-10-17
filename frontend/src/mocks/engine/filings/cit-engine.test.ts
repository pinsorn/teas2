import { beforeEach, describe, expect, it } from 'vitest';
import type { Actor, DocLine } from '@/domain/types';
import { seed, type MockState } from '../../store';
import { closeYear, reopenYear } from '../close';
import { createDraft, issue } from '../commands';
import { checkInvariants } from '../invariants';
import { withFixedClock, type MockError } from '../log';
import { taxPaymentLines } from '../reconcile';
import { netProfit } from '../reports/profit-loss';
import { citYearView, removeCitAdjustment, saveCitAdjustment, updateCitYear } from './cit';
import { filingHistory, finalizeFiling, getFiling } from './index';

// TX3a on the seed: FY2025 is the finalizable year (its twelve months are closed; the year-end close is the real command). Pure rule vectors are in cit.test.ts.
const ME: Actor = { kind: 'user', id: 'u-1', name: 'สมศรี บัญชีดี' };
const CO = 'co-vat';
let st: MockState, n = 0;
beforeEach(() => { st = seed(); });
const err = (fn: () => unknown): MockError => { try { fn(); } catch (e) { return e as MockError; } throw new Error('expected a refusal'); };
const box = (form: 'PND50' | 'PND51', period: string, code: string, co = CO) => getFiling(st, co, form, period).boxes.find((b) => b.code === code)!.amount;
const fin = (form: 'PND50' | 'PND51', period: string, co = CO) => finalizeFiling(st, co, form, period, getFiling(st, co, form, period).version, ME);
const L = (code: string, debit: string, credit: string): DocLine => ({ id: `cl-${++n}`, description: code, qty: '1', unit: '', unitPrice: '0.00', taxCode: 'EX', accountCode: code, debit, credit });
const jv2025 = (lines: DocLine[]) => withFixedClock('2025-07-01T09:00:00+07:00', () => { const d = createDraft(st, CO, 'JV', { header: { documentDate: '2025-12-20' }, lines }, ME, `cit${++n}`); return issue(st, d.id, d.version, ME); });
/** a CIT expense account the chart does not seed: the ภ.ง.ด.50 mapping p50-income-tax (added through the chart in the real app) */
const addCitAccount = () => { const a = st.accounts.find((x) => x.companyId === CO && x.code === '5110')!; st.accounts.push({ ...a, code: '5600', nameTh: 'ภาษีเงินได้นิติบุคคล', pnd50Box: 'p50-income-tax', dbdLine: 'pl-income-tax' }); };
const baht = (satang: number) => (satang / 100).toFixed(2);

describe('ภ.ง.ด.50 of FY2025 on the seed (rulings 1, 2, 3, 4, 7, 9)', () => {
  it('line 2.9 is the P&L net profit; the draft is blocked until the year-end close; the seed is invariant-clean', () => {
    expect(box('PND50', '2025', '2.9')).toBe('1247575.00');
    expect(box('PND50', '2025', '2.9')).toBe(baht(netProfit(st, CO, 2025)));
    expect(getFiling(st, CO, 'PND50', '2025').blockers.map((b) => b.code)).toEqual(['year_not_closed']);
    expect(checkInvariants(st)).toEqual([]);
  });
  it('the seed vector: user line 13, losses 2021 + 2023 used oldest first, 2019 expired, SME ladder 0 / 15', () => {
    const b = (c: string) => box('PND50', '2025', c);
    expect([b('2.13'), b('2.15'), b('2.21'), b('tax'), b('net')]).toEqual(['30000.00', '200000.00', '1017575.00', '107636.25', '107636.25']);
    const rows = getFiling(st, CO, 'PND50', '2025').attachment!.rows;
    expect(rows.filter((r) => r.code.startsWith('ขาดทุน')).map((r) => [r.code, r.amount, r.label.split('— ')[1]])).toEqual([['ขาดทุน 2562', '0.00', 'หมดอายุ (เกิน 5 รอบบัญชี)'], ['ขาดทุน 2564', '120000.00', 'ใช้หมด'], ['ขาดทุน 2566', '80000.00', 'ใช้หมด']]);
  });
  it('the tie-out of the books vs the computed tax is amber (a warning), never a blocker (ruling 8)', () => {
    expect(getFiling(st, CO, 'PND50', '2025').tieOuts[0]).toMatchObject({ labelKey: 'filing.tie.citGl', left: '107636.25', right: '0.00', diff: '107636.25' });
    closeYear(st, CO, 2025, ME);
    expect(getFiling(st, CO, 'PND50', '2025').blockers).toEqual([]);
  });
  it('finalize needs the closed year; then it freezes: one per year, the year cannot be reopened, the data is locked', () => {
    expect(err(() => fin('PND50', '2025')).code).toBe('filing.blocked');
    closeYear(st, CO, 2025, ME);
    expect(fin('PND50', '2025')).toMatchObject({ status: 'finalized', finalizedBy: ME.name, company: { taxId: '0105569012345' } });
    expect(checkInvariants(st)).toEqual([]);
    expect(err(() => fin('PND50', '2025')).code).toBe('filing.already_finalized');
    const lock = err(() => reopenYear(st, CO, 2025, ME, 'แก้ไข'));
    expect([lock.code, lock.title]).toEqual(['filing.locked', expect.stringContaining('ยื่นแบบเพิ่มเติมนอกระบบ')]);
    expect(err(() => updateCitYear(st, CO, '2025', { paidUpCapital: '9000000.00' }, ME)).code).toBe('filing.locked');
    expect(err(() => saveCitAdjustment(st, CO, '2025', { line: 10, amount: '5.00', reason: 'x' }, ME)).code).toBe('filing.locked');
    expect(err(() => removeCitAdjustment(st, CO, '2025', 'cit-adj-1', ME)).code).toBe('filing.locked');
    expect(filingHistory(st, CO, 'PND50')).toMatchObject([{ period: '2025', net: '107636.25', overpaid: false }]);
    expect(getFiling(st, CO, 'PND50', '2025').payment).toBeUndefined();
  });
  it('the frozen return is not recomputed: a later change of the year data does not move it', () => {
    closeYear(st, CO, 2025, ME); fin('PND50', '2025');
    st.citYears.find((y) => y.companyId === CO && y.year === 2025)!.paidUpCapital = '9000000.00'; // behind the engine's back
    expect(box('PND50', '2025', 'tax')).toBe('107636.25');
  });
  it('single-fault tampers are caught: a stored box, the frozen books figure, the SME flag, the ภ.ง.ด.51 credit', () => {
    closeYear(st, CO, 2025, ME); fin('PND50', '2025');
    const f = () => st.filings.find((x) => x.form === 'PND50')!;
    const caught = (msg: RegExp) => { const out = checkInvariants(st); expect(out.some((o) => msg.test(o)), out.join('\n')).toBe(true); };
    f().boxes.find((b) => b.code === '2.9')!.amount = '1.00';
    caught(/stored boxes are not what its stored snapshot gives/); caught(/line 2.9 is not the P&L net profit/);
    f().boxes.find((b) => b.code === '2.9')!.amount = '1247575.00';
    expect(checkInvariants(st)).toEqual([]);
    f().cit!.pl.revenue = '1247574.00'; caught(/books no longer give the figures/);
    f().cit!.pl.revenue = '1247575.00';
    f().cit!.sme = false; caught(/stored boxes are not what its stored snapshot gives/);
    f().cit!.sme = true;
    f().cit!.pnd51 = '5.00'; caught(/ภ.ง.ด.51 credit/);
  });
});

describe('year data and adjustments (ruling 2)', () => {
  it('a reason is required, the amount is signed and never zero, the line is 10 / 11 / 13; every change is audited', () => {
    expect(err(() => saveCitAdjustment(st, CO, '2025', { line: 10, amount: '100.00', reason: ' ' }, ME)).code).toBe('cit.reason_required');
    expect(err(() => saveCitAdjustment(st, CO, '2025', { line: 12, amount: '100.00', reason: 'x' }, ME)).code).toBe('validation.failed');
    expect(err(() => saveCitAdjustment(st, CO, '2025', { line: 10, amount: '0.00', reason: 'x' }, ME)).code).toBe('validation.failed');
    expect(err(() => saveCitAdjustment(st, CO, '2025', { line: 10, amount: 'abc', reason: 'x' }, ME)).code).toBe('validation.failed');
    const before = st.audit.length;
    saveCitAdjustment(st, CO, '2025', { line: 10, amount: '1000.00', reason: 'รายได้ตามประมวลรัษฎากร' }, ME);
    saveCitAdjustment(st, CO, '2025', { line: 11, amount: '-500.00', reason: 'ปรับลด' }, ME);
    expect([box('PND50', '2025', '2.10'), box('PND50', '2025', '2.11'), box('PND50', '2025', '2.21')]).toEqual(['1000.00', '-500.00', '1018075.00']);
    expect(st.audit.length - before).toBe(2);
    const id = citYearView(st, CO, '2025').adjustments.at(-1)!.id;
    saveCitAdjustment(st, CO, '2025', { line: 13, amount: '500.00', reason: 'เปลี่ยนบรรทัด' }, ME, id);
    expect(box('PND50', '2025', '2.13')).toBe('30500.00');
    removeCitAdjustment(st, CO, '2025', id, ME);
    expect(citYearView(st, CO, '2025').adjustments.map((a) => a.id)).toEqual(['cit-adj-1', 'cit-adj-2']);
    expect(err(() => removeCitAdjustment(st, CO, '2025', 'nope', ME)).code).toBe('cit.adjustment_not_found');
  });
  it('the SME flag follows the paid-up capital and the books revenue', () => {
    expect(citYearView(st, CO, '2025')).toMatchObject({ sme: true, revenue: '1247575.00', yearClosed: false });
    updateCitYear(st, CO, '2025', { paidUpCapital: '5000000.01' }, ME);
    expect(citYearView(st, CO, '2025').sme).toBe(false);
    expect(box('PND50', '2025', 'tax')).toBe('203515.00'); // 20 % flat of 1,017,575.00
  });
  it('a CIT expense account (mapping p50-income-tax) sits inside line 2.8, so 2.9 stays the P&L profit, and is added back at 8.1; entertainment above its cap at 8.2', () => {
    addCitAccount();
    jv2025([L('5600', '20000.00', '0.00'), L('5150', '10000.00', '0.00'), L('2120', '0.00', '30000.00')]);
    expect(box('PND50', '2025', '2.9')).toBe(baht(netProfit(st, CO, 2025)));
    expect(box('PND50', '2025', '2.9')).toBe('1217575.00');
    expect(box('PND50', '2025', '2.11')).toBe('24000.00'); // 8.1 20,000.00 + 8.2: entertainment 10,000.00 less its limit max(0.3 % x 1,247,575.00, 0.3 % x 2,000,000.00) = 6,000.00
    const rows = getFiling(st, CO, 'PND50', '2025').attachment!.rows;
    expect(rows.find((r) => r.code === '8.1')).toMatchObject({ amount: '20000.00' });
    expect(rows.find((r) => r.code === '8.2')).toMatchObject({ amount: '4000.00' });
    expect(getFiling(st, CO, 'PND50', '2025').tieOuts[0].right).toBe('20000.00');
  });
  it('an account with a balance and no ภ.ง.ด.50 mapping stops the filing (line 2.9 would not be the P&L profit)', () => {
    delete st.accounts.find((a) => a.companyId === CO && a.code === '4100')!.pnd50Box;
    expect(getFiling(st, CO, 'PND50', '2025').blockers.map((b) => b.code)).toContain('unmapped_account');
  });
});

describe('credits (ruling 5): ภ.ง.ด.51 paid and withholding with a certificate', () => {
  it('a receipt without its 50 ทวิ is a warning with the amount and no credit; entering the number credits it', () => {
    expect(getFiling(st, CO, 'PND50', '2026').warnings.find((x) => x.includes('ยังไม่มีหนังสือรับรอง — เครดิตไม่ได้'))).toContain('300.00');
    expect(box('PND50', '2026', 'creditWht')).toBe('30.00');
    st.docs.find((d) => d.id === 'rc-nocert')!.allocations!.forEach((a) => { if (a.wht && !a.certNumber) a.certNumber = 'ท.2569/0999'; });
    expect(box('PND50', '2026', 'creditWht')).toBe('330.00');
  });
  it('the finalized ภ.ง.ด.51 of the year is credited, and a thin estimate draws the under-estimate warning on the ภ.ง.ด.50', () => {
    updateCitYear(st, CO, '2025', { estimate: { mode: 'input', netProfit: '600000.00' } }, ME);
    fin('PND51', '2025');
    expect(box('PND51', '2025', 'estimateTax')).toBe('45000.00'); // 15 % of 300,000.00
    expect(box('PND51', '2025', 'tax')).toBe('22500.00');
    expect(box('PND50', '2025', 'credit51')).toBe('22500.00');
    expect(box('PND50', '2025', 'net')).toBe('85136.25');
    expect(getFiling(st, CO, 'PND50', '2025').warnings.some((x) => x.includes('ต่ำกว่าภาษีที่คำนวณได้จริง'))).toBe(true);
    closeYear(st, CO, 2025, ME); fin('PND50', '2025');
    expect(checkInvariants(st)).toEqual([]);
    st.filings.find((f) => f.form === 'PND51')!.pnd51!.estimateProfit = '1.00';
    expect(checkInvariants(st).some((o) => /PND51 .*stored boxes/.test(o))).toBe(true);
  });
});

describe('ภ.ง.ด.51 (ruling 6): the estimate path and the H1 x 2 path', () => {
  it('H1 x 2 is the default: months 1-6 closed in the seed; tax = 50 % of the tax on the estimate, less the H1 withholding, floor 0', () => {
    expect(getFiling(st, CO, 'PND51', '2025').blockers).toEqual([]);
    expect(box('PND51', '2025', 'estimate')).toBe('1735000.00');
    expect(box('PND51', '2025', 'estimateTax')).toBe('215250.00'); // 300,000 x 0 + 1,435,000 x 15 %
    expect(box('PND51', '2025', 'tax')).toBe('107625.00');
  });
  it('the H1 x 2 path needs months 1-6 closed; the estimate path does not', () => {
    st.periods.find((p) => p.companyId === CO && p.month === '2025-03')!.status = 'open';
    expect(getFiling(st, CO, 'PND51', '2025').blockers.map((b) => b.code)).toEqual(['h1_not_closed']);
    updateCitYear(st, CO, '2025', { estimate: { mode: 'input', netProfit: '1000000.00' } }, ME);
    expect(getFiling(st, CO, 'PND51', '2025').blockers).toEqual([]);
    expect(box('PND51', '2025', 'tax')).toBe('52500.00'); // 15 % of 700,000.00 = 105,000.00; half
  });
  it('withholding of months 1-6 (with a certificate) is deducted, never below zero', () => {
    const rc = st.docs.find((d) => d.id === 'rc-nocert')!;
    rc.header.documentDate = '2026-02-10'; rc.allocations!.forEach((a) => { if (a.wht) a.certNumber = 'ท.2569/0001'; });
    updateCitYear(st, CO, '2026', { estimate: { mode: 'input', netProfit: '1000.00' } }, ME);
    expect(Number(box('PND51', '2026', 'wht'))).toBeGreaterThanOrEqual(300);
    expect(box('PND51', '2026', 'tax')).toBe('0.00');
  });
  it('an input estimate must be given; a negative estimate pays nothing', () => {
    expect(err(() => updateCitYear(st, CO, '2025', { estimate: { mode: 'input' } }, ME)).code).toBe('validation.failed');
    updateCitYear(st, CO, '2025', { estimate: { mode: 'input', netProfit: '-50000.00' } }, ME);
    expect(box('PND51', '2025', 'tax')).toBe('0.00');
  });
  it('finalizing locks the estimate inputs (not the losses)', () => {
    fin('PND51', '2025');
    expect(err(() => updateCitYear(st, CO, '2025', { estimate: { mode: 'h1x2' } }, ME)).code).toBe('filing.locked');
    expect(err(() => updateCitYear(st, CO, '2025', { paidUpCapital: '1.00' }, ME)).code).toBe('filing.locked');
    expect(err(() => fin('PND51', '2025')).code).toBe('filing.already_finalized');
    updateCitYear(st, CO, '2025', { losses: [{ year: 2022, amount: '10.00' }] }, ME);
    expect(checkInvariants(st)).toEqual([]);
  });
});

describe('payment and bad periods', () => {
  it('a CIT return cannot be paid from a bank line (no CIT journal, ruling 8)', () => {
    fin('PND51', '2025');
    expect(err(() => taxPaymentLines(st, CO, 'PND51', '2025')).code).toBe('tax_payment.not_supported');
  });
  it('a period outside the books is refused', () => {
    expect(err(() => getFiling(st, CO, 'PND50', '2031')).code).toBe('filing.bad_period');
    expect(err(() => getFiling(st, CO, 'PND50', '2025-05')).code).toBe('filing.bad_period');
  });
});
