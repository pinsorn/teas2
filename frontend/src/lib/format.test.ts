import { describe, expect, it } from 'vitest';
import { formatDateBE, formatMoney, formatTHB, todayIso } from './format';

describe('format', () => {
  it('Buddhist-era date', () => expect(formatDateBE('2026-10-14')).toBe('14 ต.ค. 2569'));
  it('money with grouping, 2 dp, from a string (no float)', () => {
    expect(formatMoney('64200')).toBe('64,200.00');
    expect(formatMoney('-1234567.5')).toBe('-1,234,567.50');
    expect(formatMoney('99999999999999.99')).toBe('99,999,999,999,999.99');
  });
  it('THB', () => expect(formatTHB('64200.00')).toBe('฿64,200.00'));
  it('negative THB puts the sign before the symbol', () => {
    expect(formatTHB('-5')).toBe('-฿5.00');
    expect(formatTHB('-1234.5')).toBe('-฿1,234.50');
  });
  it('todayIso is the local calendar date', () => expect(todayIso(new Date(2026, 9, 4))).toBe('2026-10-04'));
});
