import { describe, expect, it } from 'vitest';
import { formatDateBE, formatMoney, formatTHB } from './format';

describe('format', () => {
  it('Buddhist-era date', () => expect(formatDateBE('2026-10-14')).toBe('14 ต.ค. 2569'));
  it('money with grouping, 2 dp, from a string (no float)', () => {
    expect(formatMoney('64200')).toBe('64,200.00');
    expect(formatMoney('-1234567.5')).toBe('-1,234,567.50');
    expect(formatMoney('99999999999999.99')).toBe('99,999,999,999,999.99');
  });
  it('THB', () => expect(formatTHB('64200.00')).toBe('฿64,200.00'));
});
