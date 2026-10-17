import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Actor, DocLine } from '@/domain/types';
import { seed, type MockState } from '../../store';
import { closeYear, reopenYear } from '../close';
import { createDraft, issue } from '../commands';
import { checkInvariants } from '../invariants';
import { withFixedClock, type MockError } from '../log';
import { taxPaymentLines } from '../reconcile';
import { netProfit } from '../reports/profit-loss';
import { citBuild, citDerive, citWarnings, citYearView, removeCitAdjustment, saveCitAdjustment, updateCitYear } from './cit';
import { filingHistory, finalizeFiling, getFiling } from './index';

// the mock world's today is 2026-10-17, so FY2026 can never close; the two-year tests move it past the year end for the one year-end close (close2026)
vi.mock('../log', async (orig) => { const m = await orig<typeof import('../log')>(); return { ...m, today: () => (globalThis as { __TODAY?: string }).__TODAY ?? m.today() }; });

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
    expect(getFiling(st, CO, 'PND50', '2025').warnings.some((x) => x.includes('ต่ำกว่ากำไรสุทธิที่ต้องเสียภาษีจริง'))).toBe(true);
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

// ---------------------------------------------------------------- TX3a fix round 1 (rulings 1-7)
const f50 = (y = '2025') => st.filings.find((x) => x.form === 'PND50' && x.period === y)!;
const f51 = () => st.filings.find((x) => x.form === 'PND51')!;
const caught = (re: RegExp) => { const out = checkInvariants(st); expect(out.some((o) => re.test(o)), out.join('\n')).toBe(true); };
const codes = (form: 'PND50' | 'PND51', y: string) => getFiling(st, CO, form, y).blockers.map((b) => b.code);
/** FY2026 closed for the test (the seed stops at 2026-06): its months set closed behind the engine's back, then the real year-end close */
const close2026 = () => { for (const p of st.periods) if (p.companyId === CO && p.month.startsWith('2026-')) { p.status = 'closed'; p.closedAt = '2099-01-01T00:00:00+07:00'; } (globalThis as { __TODAY?: string }).__TODAY = '2027-01-10'; try { closeYear(st, CO, 2026, ME); } finally { delete (globalThis as { __TODAY?: string }).__TODAY; } };

describe('H1 (ruling 1): no ภ.ง.ด.51 after the ภ.ง.ด.50 of the year', () => {
  it('the reviewer sequence: close, ภ.ง.ด.50, then ภ.ง.ด.51 is blocked on the draft and refused on finalize; the invariants stay clean', () => {
    closeYear(st, CO, 2025, ME); fin('PND50', '2025');
    expect(codes('PND51', '2025')).toEqual(['pnd50_filed']);
    expect(err(() => fin('PND51', '2025')).code).toBe('filing.blocked');
    expect(st.filings.some((x) => x.form === 'PND51')).toBe(false);
    expect(checkInvariants(st)).toEqual([]);
  });
});

describe('H2 (ruling 2): a loss is used once across the years', () => {
  const big = (y: string) => updateCitYear(st, CO, y, { losses: [{ year: 2023, amount: '1500000.00' }] }, ME);
  it('2025 uses what the profit allows; 2026 gets only the remainder; the sum is the loss, and the invariants are clean', () => {
    big('2025'); big('2026');
    expect(codes('PND50', '2026')).toContain('earlier_year_unfiled'); // draft chain: the 2026 draft previews the full loss until 2025 is filed, and cannot be filed first
    closeYear(st, CO, 2025, ME); fin('PND50', '2025');
    expect(box('PND50', '2025', '2.15')).toBe('1217575.00'); // 1,247,575.00 - 30,000.00 (line 13), all of it
    expect(box('PND50', '2026', '2.15')).toBe('282425.00'); // 1,500,000.00 - 1,217,575.00
    expect(getFiling(st, CO, 'PND50', '2026').attachment!.rows.find((r) => r.code === 'ขาดทุน 2566')!.basis).toContain('ใช้ไปแล้วในปีก่อน 1217575.00 บาท');
    close2026(); fin('PND50', '2026');
    expect(box('PND50', '2026', '2.15')).toBe('282425.00');
    expect(checkInvariants(st)).toEqual([]);
  });
  it('a loss used up in the first year shows consumed in the next (the seed 2021 / 2023 losses)', () => {
    closeYear(st, CO, 2025, ME); fin('PND50', '2025');
    expect(box('PND50', '2026', '2.15')).toBe('0.00');
    expect(getFiling(st, CO, 'PND50', '2026').attachment!.rows.filter((r) => r.code.startsWith('ขาดทุน')).map((r) => r.label.split('— ')[1])).toEqual(['หมดอายุ (เกิน 5 รอบบัญชี)', 'ใช้หมดแล้วในปีก่อน', 'ใช้หมดแล้วในปีก่อน']);
  });
  it('the remainder still expires: a 2020 loss partly used in 2025 is expired in 2026', () => {
    updateCitYear(st, CO, '2025', { losses: [{ year: 2020, amount: '5000000.00' }] }, ME); updateCitYear(st, CO, '2026', { losses: [{ year: 2020, amount: '5000000.00' }] }, ME);
    closeYear(st, CO, 2025, ME); fin('PND50', '2025');
    expect(box('PND50', '2025', '2.15')).toBe('1217575.00');
    expect(box('PND50', '2026', '2.15')).toBe('0.00');
    expect(getFiling(st, CO, 'PND50', '2026').attachment!.rows.find((r) => r.code === 'ขาดทุน 2563')!.label).toContain('หมดอายุ');
  });
  it('invariant: the uses before are what the earlier finalized returns used (a lowered figure would let a loss be used twice)', () => {
    big('2025'); big('2026');
    closeYear(st, CO, 2025, ME); fin('PND50', '2025'); close2026(); fin('PND50', '2026');
    expect(checkInvariants(st)).toEqual([]);
    f50('2026').cit!.lossUsedBefore = [];
    caught(/losses used before/);
  });
  it('a year cannot be filed before an earlier year that exists (and the reverse order is refused too)', () => {
    const row = st.citYears.splice(st.citYears.findIndex((y) => y.companyId === CO && y.year === 2025), 1)[0]; // no 2025 data yet
    closeYear(st, CO, 2025, ME); close2026(); fin('PND50', '2026');
    st.citYears.push(row);
    expect(codes('PND50', '2025')).toContain('later_year_filed');
    expect(err(() => fin('PND50', '2025')).code).toBe('filing.blocked');
  });
});

describe('M1 (ruling 3): the filed return freezes the account mapping and class', () => {
  it('a chart remap after filing: invariants clean, the filed return unchanged, the next draft uses the new mapping', () => {
    closeYear(st, CO, 2025, ME); fin('PND50', '2025');
    const before = JSON.stringify(f50().boxes), rev26 = box('PND50', '2026', '2.1');
    const a = st.accounts.find((x) => x.companyId === CO && x.code === '4100')!;
    a.pnd50Box = 'p50-other-income-misc';
    expect(checkInvariants(st)).toEqual([]);
    expect(JSON.stringify(getFiling(st, CO, 'PND50', '2025').boxes)).toBe(before);
    expect(box('PND50', '2026', '2.1')).not.toBe(rev26); // 4100 is no longer direct revenue in an unfiled year
    a.class = 'other-income'; // the class is frozen too (the year-end close's own invariants are not this return's)
    expect(checkInvariants(st)).toEqual([]);
    expect(f50().cit!.map['4100']).toEqual({ box: 'p50-revenue-direct', class: 'sales-revenue' });
    expect(box('PND50', '2025', '2.9')).toBe('1247575.00');
  });
  it('tamper: a frozen mapping edited to give other figures is caught', () => {
    closeYear(st, CO, 2025, ME); fin('PND50', '2025');
    f50().cit!.map['4100'].box = 'p50-other-income-misc';
    caught(/books no longer give the figures/);
  });
});

describe('M2 (ruling 4): single-fault tampers on a finalized return are caught', () => {
  const fault = (mutate: () => void, re: RegExp, undo: () => void) => { expect(checkInvariants(st)).toEqual([]); mutate(); caught(re); undo(); expect(checkInvariants(st)).toEqual([]); };
  it('ภ.ง.ด.50: paid-up capital vs the SME flag, the ภ.ง.ด.51 tax, the ภ.ง.ด.51 estimate, the uncertified list, the adjustments and the losses', () => {
    updateCitYear(st, CO, '2025', { estimate: { mode: 'input', netProfit: '600000.00' } }, ME);
    fin('PND51', '2025'); closeYear(st, CO, 2025, ME); fin('PND50', '2025');
    const s = f50().cit!;
    fault(() => { s.paidUpCapital = '9000000.00'; }, /SME flag/, () => { s.paidUpCapital = '2000000.00'; });
    fault(() => { s.pnd51 = '5.00'; }, /ภ.ง.ด.51 credit/, () => { s.pnd51 = '22500.00'; });
    fault(() => { s.pnd51Estimate!.profit = '999999.00'; }, /ภ.ง.ด.51 estimate/, () => { s.pnd51Estimate!.profit = '600000.00'; });
    fault(() => { s.uncertified = [{ rcId: 'x', number: 'x', date: '2025-01-01', customer: 'x', target: 'x', certNumber: '', amount: '1.00' }]; }, /uncertified/, () => { s.uncertified = []; });
    fault(() => { s.user[0].basis = 'tampered'; }, /adjustments.*locked year data/, () => { s.user[0].basis = 'รายจ่ายที่หักได้เพิ่มขึ้น ม.65 ทวิ — ค่าฝึกอบรมพนักงาน'; });
    fault(() => { s.losses[0].amount = '51000.00'; }, /losses.*locked year data/, () => { s.losses[0].amount = '50000.00'; });
  });
  it('ภ.ง.ด.51: the H1 profit under H1 x 2 (estimate = H1 x 2), and its SME flag', () => {
    fin('PND51', '2025');
    const s = f51().pnd51!, h1 = s.h1Profit;
    fault(() => { s.h1Profit = '1.00'; }, /H1 x 2/, () => { s.h1Profit = h1; });
    fault(() => { s.sme = false; }, /SME flag/, () => { s.sme = true; });
  });
});

describe('M3 (ruling 5): the under-estimate warning compares profit, on the estimate path only', () => {
  const warns = (profit: string, mode: 'input' | 'h1x2') => {
    const s = citBuild(st, CO, 'PND50', '2025').cit!;
    Object.assign(s.pl, { revenue: '400000.00', cost: '0.00', otherIncome: '0.00', otherExpense: '0.00', sga: '0.00', entertainment: '0.00', citExpense: '0.00', charity: '0.00', education: '0.00' });
    s.user = []; s.losses = []; s.lossUsedBefore = []; s.sme = true; s.pnd51Estimate = { mode, profit };
    expect(citDerive(s).taxable).toBe(40_000_000);
    return citWarnings(s).some((x) => x.includes('ต่ำกว่ากำไรสุทธิที่ต้องเสียภาษีจริง'));
  };
  it('actual 400,000.00 vs estimate 300,000.00 (exactly 25 % short): no warning; 299,999.00: warning; H1 x 2: never', () => {
    expect(warns('300000.00', 'input')).toBe(false);
    expect(warns('299999.00', 'input')).toBe(true);
    expect(warns('0.00', 'h1x2')).toBe(false);
  });
});

describe('M4 + L2 (ruling 6, 7): the seed chart has the CIT expense account; 8.1 is the signed balance', () => {
  it('5600 is seeded on the p50-income-tax line, class income-tax', () => {
    expect(st.accounts.find((a) => a.companyId === CO && a.code === '5600')).toMatchObject({ pnd50Box: 'p50-income-tax', dbdLine: 'pl-income-tax', class: 'income-tax', postable: true });
  });
  it('a credit balance on 5600 reduces the add-back (8.1 negative); the profit floor is the final taxable profit, not 8.1', () => {
    jv2025([L('2120', '10000.00', '0.00'), L('5600', '0.00', '10000.00')]);
    expect(box('PND50', '2025', '2.9')).toBe('1257575.00');
    expect(box('PND50', '2025', '2.11')).toBe('-10000.00');
    expect(box('PND50', '2025', '2.21')).toBe('1017575.00');
  });
});

describe('L3 (ruling 7): the loss input refuses the fiscal year or later, and duplicate years', () => {
  it('422 each', () => {
    expect(err(() => updateCitYear(st, CO, '2025', { losses: [{ year: 2025, amount: '10.00' }] }, ME)).code).toBe('validation.failed');
    expect(err(() => updateCitYear(st, CO, '2025', { losses: [{ year: 2026, amount: '10.00' }] }, ME)).code).toBe('validation.failed');
    expect(err(() => updateCitYear(st, CO, '2025', { losses: [{ year: 2021, amount: '10.00' }, { year: 2021, amount: '5.00' }] }, ME)).code).toBe('validation.failed');
    updateCitYear(st, CO, '2025', { losses: [{ year: 2021, amount: '10.00' }, { year: 2022, amount: '5.00' }] }, ME);
  });
});

describe('fix2: a loss amount a filed return froze is kept (R2-M1), the way out is named, line 2.9 is the shared P&L profit', () => {
  it('2025 filed with 2021 = 120,000: 2026 entering 500,000 is refused (422, names the year and amount); the same amount, or none (prefilled), is accepted', () => {
    closeYear(st, CO, 2025, ME); fin('PND50', '2025');
    const e = err(() => updateCitYear(st, CO, '2026', { losses: [{ year: 2021, amount: '500000.00' }, { year: 2023, amount: '80000.00' }] }, ME));
    expect([e.status, e.code]).toEqual([422, 'cit.loss_amount_filed']);
    expect(e.title).toContain('2564'); expect(e.title).toContain('120000.00');
    updateCitYear(st, CO, '2026', { losses: [{ year: 2021, amount: '120000.00' }, { year: 2023 } as never] }, ME); // 2023 prefilled from the filed return
    expect(citYearView(st, CO, '2026').losses).toEqual([{ year: 2021, amount: '120000.00' }, { year: 2023, amount: '80000.00' }]);
    expect(err(() => updateCitYear(st, CO, '2026', { losses: [{ year: 2030 } as never] }, ME)).code).toBe('validation.failed'); // nothing filed to prefill from
  });
  it('a draft whose typed amount differs (typed before the earlier year was filed) is blocked', () => {
    st.citYears.find((y) => y.companyId === CO && y.year === 2026)!.losses = [{ year: 2021, amount: '500000.00' }];
    closeYear(st, CO, 2025, ME); fin('PND50', '2025');
    expect(codes('PND50', '2026')).toContain('loss_amount_filed');
  });
  it('invariant: every finalized return lists a loss year with the amount the earliest one froze', () => {
    closeYear(st, CO, 2025, ME); fin('PND50', '2025'); close2026(); fin('PND50', '2026');
    expect(checkInvariants(st)).toEqual([]);
    f50('2026').cit!.losses[1].amount = '500000.00'; // a stored amount, behind the engine's back
    caught(/loss of 2021 .*amount .* earlier/);
  });
  it('the way out of earlier_year_unfiled is named', () => {
    updateCitYear(st, CO, '2026', { losses: [{ year: 2021, amount: '120000.00' }] }, ME);
    expect(getFiling(st, CO, 'PND50', '2026').blockers.find((b) => b.code === 'earlier_year_unfiled')!.labelTh).toContain('ลบขาดทุนนั้นออกจากข้อมูลของปีนั้น');
  });
  it('line 2.9 of the CIT return is the shared P&L netProfit for 2025 and 2026 on the seed', () => {
    for (const y of [2025, 2026]) expect(box('PND50', String(y), '2.9')).toBe(baht(netProfit(st, CO, y)));
  });
});
