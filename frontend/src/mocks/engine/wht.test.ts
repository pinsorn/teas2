import { describe, expect, it } from 'vitest';
import type { Actor, PartySummary } from '@/domain/types';
import { buildSeedState } from '../store';
import { fromSatang, toSatang } from './money';
import { createDraft, issue } from './commands';
import { assertBalanced } from './test-helpers';
import { computeWht, formFor } from './wht';

const me: Actor = { kind: 'user', id: 'u-1', name: 'สมศรี บัญชีดี' };
const party = (entityKind: PartySummary['entityKind'], id = 'pv-01'): PartySummary =>
  ({ id, kind: 'vendor', code: 'V01', name: 'x', vatRegistered: false, paymentTermDays: 30, entityKind });
const st = buildSeedState();
const DATE = '2026-10-14';

describe('computeWht: one hand-computed vector per payer mode [SP-R fixtures]', () => {
  // SVC 3 % (300 bp) on a net base of 5,000.00 = 500000 satang
  it.each([
    // mode, base, tax, income, expense   (deduct: 500000 x 3 % = 15000; always: income = round(500000 / 0.97) = 515463.92 -> 515464, tax = round(515464 x 3 %) = 15463.92 -> 15464;
    //                                      once: income = 500000 x 1.03 = 515000, tax = round(515000 x 3 %) = 15450)
    ['deduct', 500000, 15000, 500000, 0],
    ['grossup_always', 500000, 15464, 515464, 15464],
    ['grossup_once', 500000, 15450, 515000, 15450],
  ] as const)('%s: base %i -> tax %i, income %i, expense %i', (mode, base, tax, income, expense) => {
    const r = computeWht([{ net: base, whtTypeCode: 'SVC' }], mode, party('juristic'), DATE, st);
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toMatchObject({ code: 'SVC', base: fromSatang(base), rate: '3%', tax: fromSatang(tax), income: fromSatang(income) });
    expect(r.tax).toBe(tax);
    expect(r.expense).toBe(expense);
  });
  it('rounds half away from zero and keeps integer satang (16650 x 3 % = 499.5 -> 500; always: 1000 -> income 1031, tax 31)', () => {
    expect(computeWht([{ net: 16650, whtTypeCode: 'SVC' }], 'deduct', party('juristic'), DATE, st).tax).toBe(500);
    const g = computeWht([{ net: 1000, whtTypeCode: 'SVC' }], 'grossup_always', party('juristic'), DATE, st);
    expect([g.lines[0].income, g.lines[0].tax]).toEqual([fromSatang(1031), fromSatang(31)]);
  });
  it('gross-up (always) satisfies net paid + WHT = grossed amount exactly when income - tax = base', () => {
    const r = computeWht([{ net: 500000, whtTypeCode: 'SVC' }], 'grossup_always', party('juristic'), DATE, st);
    expect(toSatang(r.lines[0].income) - r.tax).toBe(500000);
  });
  it('0.75 % (AGRI) is exact: 1,000,000 satang -> 7,500', () => {
    const r = computeWht([{ net: 1000000, whtTypeCode: 'AGRI' }], 'deduct', party('individual'), DATE, st);
    expect([r.lines[0].rate, r.tax]).toEqual(['0.75%', 7500]);
  });
});

describe('document level', () => {
  it('one WHT line per WHT type; Σ lines tax = document wht (I7); untyped lines carry no WHT', () => {
    const r = computeWht([
      { net: 500000, whtTypeCode: 'SVC' }, { net: 200000, whtTypeCode: 'RENT' }, { net: 100000, whtTypeCode: 'SVC' }, { net: 999999 },
    ], 'deduct', party('juristic'), DATE, st);
    expect(r.lines.map((l) => [l.code, l.base, l.tax])).toEqual([['SVC', '6000.00', '180.00'], ['RENT', '2000.00', '100.00']]);
    expect(r.tax).toBe(r.lines.reduce((a, l) => a + toSatang(l.tax), 0));
    expect(r.tax).toBe(28000);
  });
  it('an unknown or not-yet-effective type is refused', () => {
    expect(() => computeWht([{ net: 100, whtTypeCode: 'NOPE' }], 'deduct', party('juristic'), DATE, st)).toThrow(/wht.unknown_type/);
    expect(() => computeWht([{ net: 100, whtTypeCode: 'SVC' }], 'deduct', party('juristic'), '2019-12-31', st)).toThrow(/wht.unknown_type/);
  });
  it('form routing: SVC to an individual -> PND3, to a juristic -> PND53; INT-IND -> PND2; FOR-SVC -> PND54', () => {
    const t = (code: string) => st.whtTypes.find((x) => x.companyId === 'co-vat' && x.code === code)!;
    expect(formFor(t('SVC'), party('individual'))).toBe('PND3');
    expect(formFor(t('SVC'), party('juristic'))).toBe('PND53');
    expect(formFor(t('INT-IND'), party('individual'))).toBe('PND2');
    expect(formFor(t('INT-IND'), party('juristic'))).toBe('PND53'); // pnd2 only applies to an individual payee
    expect(formFor(t('FOR-SVC'), party('foreign'))).toBe('PND54');
  });
});

describe('PV journal balances in all three modes (Dr = Cr) and posts the WHT roles', () => {
  const pv = (mode: 'deduct' | 'grossup_once' | 'grossup_always', payee: string) => {
    const s = buildSeedState();
    const d = createDraft(s, 'co-vat', 'PV', {
      header: { partyId: payee, documentDate: DATE, whtMode: mode },
      lines: [{ id: 'l1', description: 'ค่าถ่ายภาพ', qty: '1', unit: 'งาน', unitPrice: '5000.00', taxCode: 'EX', whtTypeCode: 'SVC' }],
    }, me, `pv-${mode}`);
    const done = issue(s, d.id, d.version, me);
    return { s, done, lines: s.journals.find((j) => j.docId === done.id)!.preview.entries[0].lines };
  };
  const row = (lines: { accountCode: string; debit: string; credit: string }[], code: string) => lines.find((l) => l.accountCode === code);

  it('deduct: Dr expense 5,000.00; Cr WHT payable (PND53 2132) 150.00; Cr bank 4,850.00', () => {
    const { s, done, lines } = pv('deduct', 'pv-01');
    assertBalanced(s);
    expect([done.totals.total, done.totals.wht, done.totals.cash]).toEqual(['5000.00', '150.00', '4850.00']);
    expect(row(lines, '5100')?.debit).toBe('5000.00');
    expect(row(lines, '2132')?.credit).toBe('150.00');
    expect(row(lines, '1121')?.credit).toBe('4850.00'); // the default bank account reaches the Cash role
    expect(row(lines, '5180')).toBeUndefined();
  });
  it('grossup_always: cash = total 5,000.00; the tax 154.64 is our expense (WhtExpense 5180)', () => {
    const { s, done, lines } = pv('grossup_always', 'pv-01');
    assertBalanced(s);
    expect([done.totals.total, done.totals.wht, done.totals.cash]).toEqual(['5000.00', '154.64', '5000.00']);
    expect(row(lines, '5180')?.debit).toBe('154.64');
    expect(row(lines, '2132')?.credit).toBe('154.64');
    expect(row(lines, '1121')?.credit).toBe('5000.00');
  });
  it('grossup_once: tax 154.50 borne by us; cash 5,000.00', () => {
    const { s, done, lines } = pv('grossup_once', 'pv-01');
    assertBalanced(s);
    expect([done.totals.wht, done.totals.cash]).toEqual(['154.50', '5000.00']);
    expect(row(lines, '5180')?.debit).toBe('154.50');
  });
});
