import { describe, expect, it } from 'vitest';
import type { DocLine } from '@/domain/types';
import { computeDoc, computeLine } from './vat';

const line = (p: Partial<DocLine>): DocLine => ({ id: 'l', description: 'x', qty: '1', unit: 'งาน', unitPrice: '0.00', taxCode: 'S7', ...p });

describe('VAT per line, half away from zero (SP0 I2)', () => {
  it('standard rate, exclusive', () => {
    expect(computeLine(line({ unitPrice: '60000.00' }), false)).toMatchObject({ net: 6000000, vat: 420000, total: 6420000 });
  });
  it('half-satang edge: 3 x 0.15', () => {
    expect(computeLine(line({ qty: '3', unitPrice: '0.15' }), false)).toMatchObject({ net: 45, vat: 3, total: 48 });
  });
  it('thirds: 33.33', () => {
    expect(computeLine(line({ unitPrice: '33.33' }), false)).toMatchObject({ net: 3333, vat: 233, total: 3566 });
  });
  it('line discount 12.5 %', () => {
    expect(computeLine(line({ qty: '7', unitPrice: '12.35', discountPct: '12.5' }), false))
      .toMatchObject({ gross: 8645, discount: 1081, net: 7564, vat: 529, total: 8093 });
  });
  it('VAT-inclusive price', () => {
    expect(computeLine(line({ unitPrice: '100.00' }), true)).toMatchObject({ net: 9346, vat: 654, total: 10000 });
  });
  it('credit-side (negative) amounts round half away from zero', () => {
    expect(computeLine(line({ qty: '3', unitPrice: '-0.15' }), false)).toMatchObject({ net: -45, vat: -3, total: -48 });
  });
  it('refuses amounts beyond safe integer satang', () => {
    expect(() => computeLine(line({ qty: '1000000', unitPrice: '99999999999.99' }), false)).toThrow('amount too large');
  });
  it('zero-rated and exempt lines carry no VAT', () => {
    expect(computeLine(line({ unitPrice: '25000.00', taxCode: 'Z0' }), false)).toMatchObject({ vat: 0, total: 2500000 });
    expect(computeLine(line({ unitPrice: '350.00', qty: '10', taxCode: 'EX' }), false)).toMatchObject({ vat: 0, total: 350000 });
  });
  it('header totals are sums of lines and carry the amount in words', () => {
    const r = computeDoc([line({ id: 'a', unitPrice: '60000.00' }), line({ id: 'b', unitPrice: '0.15', qty: '3' })], false);
    expect(r.totals).toMatchObject({ gross: '60000.45', discount: '0.00', net: '60000.45', vat: '4200.03', total: '64200.48' });
    expect(r.totals.amountInWords).toBe('หกหมื่นสี่พันสองร้อยบาทสี่สิบแปดสตางค์');
  });
});
