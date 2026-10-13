import { describe, expect, it } from 'vitest';
import { divRoundHalfAway, fromSatang, mulQtyPrice, toSatang } from './money';

describe('money', () => {
  it('parses and prints satang', () => {
    expect(toSatang('64200.00')).toBe(6420000);
    expect(toSatang('-0.5')).toBe(-50);
    expect(fromSatang(6420000)).toBe('64200.00');
    expect(fromSatang(-5)).toBe('-0.05');
    expect(() => toSatang('1.234')).toThrow();
  });
  it('rounds half away from zero', () => {
    expect(divRoundHalfAway(315n, 100n)).toBe(3n);
    expect(divRoundHalfAway(350n, 100n)).toBe(4n);
    expect(divRoundHalfAway(-350n, 100n)).toBe(-4n);
    expect(divRoundHalfAway(-315n, 100n)).toBe(-3n);
  });
  it('multiplies quantity by price exactly (bigint), even beyond 2^53', () => {
    expect(mulQtyPrice('3', 15)).toBe(45n);
    expect(mulQtyPrice('2.5', 1999)).toBe(4998n); // 49.975 baht -> 49.98
    expect(mulQtyPrice('1000000', 99_999_999_999)).toBe(99_999_999_999_000_000n);
  });
});
