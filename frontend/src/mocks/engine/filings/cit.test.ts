import { describe, expect, it } from 'vitest';
import { citTax, donationExcess, entertainmentLimit, isSme, lossSetOff } from './cit';

// TX3a: the CIT rules as pure vectors (the [SP-R] fixture values of mocks/fixtures/cit-year.ts). Money in satang.
const B = (baht: number) => Math.round(baht * 100);

describe('SME flag (ruling 4): paid-up capital <= 5 MB AND revenue <= 30 MB, frozen at finalize', () => {
  it.each([
    [5_000_000, 30_000_000, true], [5_000_000.01, 30_000_000, false], [5_000_000, 30_000_000.01, false], [0, 0, true], [6_000_000, 40_000_000, false],
  ])('capital %s revenue %s -> %s', (cap, rev, want) => { expect(isSme(B(cap), B(rev))).toBe(want); });
});

describe('the ladder (ruling 4): SME 0 / 15 / 20, anyone else 20 flat; band edges', () => {
  it.each([
    [0, 0], [300_000, 0], [300_001, 0.15], [1_000_000, 105_000], [3_000_000, 405_000], [3_000_000.01, 405_000], [3_000_100, 405_020], [10_000_000, 1_805_000],
  ])('SME taxable %s -> %s', (profit, tax) => { expect(citTax(B(profit), true).tax).toBe(B(tax)); });
  it.each([[0, 0], [300_000, 60_000], [3_000_000, 600_000], [1.25, 0.25]])('standard taxable %s -> %s', (profit, tax) => { expect(citTax(B(profit), false).tax).toBe(B(tax)); });
  it('a loss pays nothing, and the bands are reported with their base', () => {
    expect(citTax(-B(1000), true)).toEqual({ tax: 0, bands: [] });
    expect(citTax(B(1_000_000), true).bands).toEqual([{ from: '0.00', to: '300000.00', rateBp: 0, base: '300000.00' }, { from: '300000.00', to: '1000000.00', rateBp: 1500, base: '700000.00' }]);
  });
  it('rounds once over the whole tax, half away from zero (0.15 satang -> 0, 0.5 satang -> 1)', () => {
    expect(citTax(30_000_001, true).tax).toBe(0); // 1 satang over the 300,000.00 line x 15 % = 0.15 satang
    expect(citTax(30_000_003, true).tax).toBe(0); // 0.45
    expect(citTax(30_000_004, true).tax).toBe(1); // 0.60
    expect(citTax(30_000_010, true).tax).toBe(2); // 1.50 -> half away from zero
  });
});

describe('loss carry-forward (ruling 3, I11): 5 years, oldest first, expired drop', () => {
  const L = (year: number, baht: number) => ({ year, amount: `${baht}.00` });
  it('a loss of exactly five years back still counts, six years back is expired', () => {
    const r = lossSetOff([L(2020, 100), L(2019, 100)], 2025, B(1000));
    expect(r.used).toBe(B(100));
    expect(r.rows).toEqual([{ year: 2019, amount: '100.00', used: '0.00', status: 'expired' }, { year: 2020, amount: '100.00', used: '100.00', status: 'used' }]);
  });
  it('the year of the loss itself and later years do not count', () => {
    expect(lossSetOff([L(2025, 100), L(2026, 100)], 2025, B(1000)).used).toBe(0);
  });
  it('oldest first, limited by the profit, the rest stays unused / partly used', () => {
    const r = lossSetOff([L(2023, 80), L(2021, 120), L(2024, 70)], 2025, B(150));
    expect(r.used).toBe(B(150));
    expect(r.rows.map((x) => [x.year, x.used, x.status])).toEqual([[2021, '120.00', 'used'], [2023, '30.00', 'partly'], [2024, '0.00', 'unused']]);
  });
  it('no profit, no set-off', () => { expect(lossSetOff([L(2024, 50)], 2025, -B(10)).used).toBe(0); expect(lossSetOff([L(2024, 50)], 2025, 0).rows[0].status).toBe('unused'); });
});

describe('entertainment (ruling 2): the larger of 0.3 % of revenue and 0.3 % of paid-up capital, never above 10 MB', () => {
  it.each([[1_000_000, 0, 3_000], [0, 2_000_000, 6_000], [1_000_000, 5_000_000, 15_000], [5_000_000_000, 0, 10_000_000]])('revenue %s capital %s -> %s', (rev, cap, limit) => {
    expect(entertainmentLimit(B(rev), B(cap))).toBe(B(limit));
  });
});

describe('donations (ruling 2): only the part above 2 % of the net profit is added back', () => {
  it.each([[1_000, 100_000, 0], [2_500, 100_000, 500], [100, 0, 100], [100, -50, 100]])('spent %s profit %s -> excess %s', (spent, profit, excess) => { expect(donationExcess(B(spent), B(profit))).toBe(B(excess)); });
});
