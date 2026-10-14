import { describe, expect, it } from 'vitest';
import { isValidTin, tinCheckDigit } from './tin';

describe('Thai 13-digit tax id', () => {
  it.each(['1234567890121', '0105569012345', '0105569056784', '0105568024684', '3100600123450'])('accepts %s', (t) => {
    expect(isValidTin(t)).toBe(true);
  });
  it.each(['1234567890122', '010556901234', 'abcdefghijklm', ''])('rejects %s', (t) => {
    expect(isValidTin(t)).toBe(false);
  });
  it('computes the check digit', () => {
    expect(tinCheckDigit('123456789012')).toBe(1);
    expect(() => tinCheckDigit('12')).toThrow();
  });
});
