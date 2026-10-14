import { describe, expect, it } from 'vitest';
import { CLASS, CONVERSIONS, DOC_TYPES, isTypeAvailable } from './doc-types';

describe('doc types (SP0 §3.1, §7.3, §7.7)', () => {
  it('classes follow §7.3', () => {
    expect(Object.entries(CLASS).filter(([, c]) => c === 'T').map(([t]) => t).sort()).toEqual(['CN', 'DN', 'RC', 'TI', 'WT']);
    expect(Object.entries(CLASS).filter(([, c]) => c === 'N').map(([t]) => t).sort()).toEqual(['BL', 'DO', 'PO', 'QT', 'SO']);
  });
  it('VAT scope: TI/CN/DN VAT-only, IV non-VAT-only, the rest both', () => {
    expect(isTypeAvailable('TI', false)).toBe(false);
    expect(isTypeAvailable('IV', true)).toBe(false);
    expect(isTypeAvailable('IV', false)).toBe(true);
    expect(isTypeAvailable('RC', false)).toBe(true);
    expect(Object.keys(DOC_TYPES).filter((t) => DOC_TYPES[t as keyof typeof DOC_TYPES].vat === 'vat-only').sort()).toEqual(['CN', 'DN', 'TI']);
  });
  it('conversions never target a type outside the source company scope pair (DO → BL is gone, D-07)', () => {
    expect(CONVERSIONS.DO).toEqual(['TI', 'IV']);
  });
});
