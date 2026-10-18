import { beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from '@/domain/types';
import type { ReportModel } from '@/domain/reports';
import { buildSeedState, type MockState } from '../../store';
import { closeYear } from '../close';
import { today } from '../log';
import { toSatang } from '../money';
import { balanceSheet } from './balance-sheet';

const ME: Actor = { kind: 'user', id: 'u-1', name: 'สมศรี บัญชีดี' };
const VAT = 'co-vat', NV = 'co-nonvat';
let st: MockState;
beforeEach(() => { st = buildSeedState(); });

/** The test's own oracle: raw journal lines from the stores, closing entries INCLUDED, dated <= asOf. */
const lines = (s: MockState, co: string, asOf: string) => [
  ...s.journals.filter((j) => s.docs.some((d) => d.id === j.docId && d.companyId === co)).flatMap((j) => j.preview.entries),
  ...s.bankJournals.filter((j) => j.companyId === co).flatMap((j) => j.entries),
  ...s.settlements.filter((x) => x.companyId === co).flatMap((x) => x.journal),
  ...s.filings.filter((f) => f.companyId === co).flatMap((f) => f.journal ?? []),
  ...s.yearCloses.filter((y) => y.companyId === co).flatMap((y) => y.journal),
].filter((e) => e.date <= asOf).flatMap((e) => e.lines);
const dr = (s: MockState, co: string, asOf: string, re: RegExp) => lines(s, co, asOf).filter((l) => re.test(l.accountCode)).reduce((a, l) => a + toSatang(l.debit) - toSatang(l.credit), 0);
const neg = (x: number) => -x || 0; // never -0
const total = (m: ReportModel, name: string, key = 'cur') => toSatang(m.rows.find((r) => r.kind === 'total' && r.cells.name === name)!.cells[key]);
const row = (m: ReportModel, code: string) => m.rows.find((r) => r.kind === 'row' && r.cells.code === code);
const UNCLOSED = 'กำไร (ขาดทุน) ที่ยังไม่ได้ปิดบัญชี';
const unclosed = (m: ReportModel, key = 'cur') => { const r = m.rows.find((x) => x.cells.name === UNCLOSED); return r ? toSatang(r.cells[key]) : 0; }; // no row = nothing unclosed
const DATES = ['2026-06-30', '2026-12-31', today()];

describe('ruling 3: balance sheet', () => {
  it.each([VAT, NV])('assets - (liabilities + equity) = 0.00 at every date (%s)', (co) => {
    for (const asOf of [...DATES, '2025-12-31']) {
      const m = balanceSheet(st, co, { asOf });
      expect(m.tieOuts![0].diff, asOf).toBe('0.00');
      expect(m.tieOuts![0].left).toBe(m.tieOuts![0].right);
      expect(total(m, 'สินทรัพย์')).toBe(dr(st, co, asOf, /^1/));
      expect(total(m, 'หนี้สิน')).toBe(neg(dr(st, co, asOf, /^2/)));
      expect(total(m, 'ส่วนของเจ้าของ')).toBe(neg(dr(st, co, asOf, /^3/) + dr(st, co, asOf, /^[45]/)));
      expect(unclosed(m)).toBe(neg(dr(st, co, asOf, /^[45]/)));
    }
    expect(balanceSheet(st, co, { asOf: '1900-01-01' }).rows).toEqual([]);
  });
  it('classifies current / non-current and shows accumulated depreciation as a deduction', () => {
    const m = balanceSheet(st, VAT, { asOf: today() });
    const at = (code: string) => m.rows.findIndex((r) => r.kind === 'row' && r.cells.code === code);
    const grp = (name: string) => m.rows.findIndex((r) => r.kind === 'group' && r.cells.name === name);
    expect(grp('สินทรัพย์หมุนเวียน')).toBeLessThan(at('1130'));
    expect(at('1130')).toBeLessThan(grp('สินทรัพย์ไม่หมุนเวียน'));
    expect(grp('สินทรัพย์ไม่หมุนเวียน')).toBeLessThan(at('1210'));
    expect(toSatang(row(m, '1210')!.cells.cur)).toBeGreaterThan(0);
    expect(toSatang(row(m, '1211')!.cells.cur)).toBeLessThan(0);
    expect(at('2110')).toBeGreaterThan(grp('หนี้สินหมุนเวียน'));
    expect(row(m, '2110')!.href).toBe(`/reports/financial-statements?tab=gl&account=2110&to=${today()}`);
    expect(m.rows.at(-1)).toMatchObject({ kind: 'total' });
  });
  it('a CLOSED year contributes 0 to the unclosed profit row and sits in retained earnings (3200)', () => {
    const open = balanceSheet(st, VAT, { asOf: '2025-12-31' });
    const profit2025 = unclosed(open);
    expect(profit2025).not.toBe(0);
    expect(row(open, '3200')).toBeUndefined();
    closeYear(st, VAT, 2025, ME);
    const m = balanceSheet(st, VAT, { asOf: '2025-12-31' });
    expect(unclosed(m)).toBe(0);
    expect(toSatang(row(m, '3200')!.cells.cur)).toBe(profit2025);
    expect(m.tieOuts![0].diff).toBe('0.00');
    for (const asOf of ['2026-06-30', today()]) {
      const later = balanceSheet(st, VAT, { asOf });
      expect(later.tieOuts![0].diff, asOf).toBe('0.00');
      expect(unclosed(later)).toBe(neg(dr(st, VAT, asOf, /^[45]/)));
      expect(toSatang(row(later, '3200')!.cells.cur)).toBe(profit2025);
    }
    // the total equity does not move by closing
    expect(total(m, 'ส่วนของเจ้าของ')).toBe(total(open, 'ส่วนของเจ้าของ'));
  });
  it('comparatives: same date last year, and the end of the previous year, with the difference', () => {
    const m = balanceSheet(st, VAT, { asOf: '2026-09-30', compare: 'lastYear' });
    expect(m.columns.map((c) => c.key)).toEqual(['code', 'name', 'cur', 'cmp', 'diff']);
    expect(total(m, 'สินทรัพย์', 'cmp')).toBe(dr(st, VAT, '2025-09-30', /^1/));
    expect(total(m, 'สินทรัพย์', 'diff')).toBe(total(m, 'สินทรัพย์') - total(m, 'สินทรัพย์', 'cmp'));
    expect(m.tieOuts!.every((t) => t.diff === '0.00')).toBe(true);
    const ye = balanceSheet(st, VAT, { asOf: '2026-09-30', compare: 'yearEnd' });
    expect(total(ye, 'สินทรัพย์', 'cmp')).toBe(dr(st, VAT, '2025-12-31', /^1/));
  });
  it('DBD format [SP-R]: lines by the account mapping; an unmapped account appears as "ยังไม่จัดกลุ่ม"', () => {
    const asOf = today();
    const by = balanceSheet(st, VAT, { asOf });
    const dbd = balanceSheet(st, VAT, { asOf, format: 'dbd' });
    expect(dbd.rows.some((r) => r.kind === 'group' && r.cells.name.includes('เงินสดและรายการเทียบเท่าเงินสด'))).toBe(true);
    expect(total(dbd, 'สินทรัพย์')).toBe(total(by, 'สินทรัพย์'));
    expect(dbd.rows.some((r) => r.cells.name.includes('ยังไม่จัดกลุ่ม'))).toBe(false);
    for (const a of st.accounts) if (a.companyId === VAT && (a.code === '1130' || a.code === '2110')) delete a.dbdLine;
    const un = balanceSheet(st, VAT, { asOf, format: 'dbd' });
    expect(un.rows.filter((r) => r.kind === 'group' && r.cells.name.includes('ยังไม่จัดกลุ่ม'))).toHaveLength(2);
    expect(un.rows.filter((r) => r.kind === 'row').map((r) => r.cells.code)).toEqual(expect.arrayContaining(['1130', '2110']));
    expect(total(un, 'สินทรัพย์')).toBe(total(by, 'สินทรัพย์'));
    expect(un.tieOuts![0].diff).toBe('0.00');
  });
  it('a corrupted journal shows as a non-zero tie-out, never hidden', () => {
    const j = st.journals.find((x) => st.docs.some((d) => d.id === x.docId && d.companyId === VAT && d.type === 'TI'))!;
    const l = j.preview.entries[0].lines.find((x) => x.accountCode === '1130')!;
    l.debit = '0.00';
    expect(balanceSheet(st, VAT, { asOf: today() }).tieOuts![0].diff).not.toBe('0.00');
  });
});
