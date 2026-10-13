import { describe, expect, it } from 'vitest';
import { SeriesAllocator, formatDocNumber } from './numbering';

describe('numbering', () => {
  it('formats PREFIX-YYYYMM-####', () => expect(formatDocNumber('TI', '2026-10-14', 7)).toBe('TI-202610-0007'));
  it('is sequential per company, type and month, and never reuses a number', () => {
    const s = new SeriesAllocator();
    expect(s.next('c1', 'TI', '2026-10-01')).toBe('TI-202610-0001');
    expect(s.next('c1', 'TI', '2026-10-20')).toBe('TI-202610-0002');
    expect(s.next('c1', 'TI', '2026-11-02')).toBe('TI-202611-0001');
    expect(s.next('c2', 'TI', '2026-10-02')).toBe('TI-202610-0001');
    expect(s.next('c1', 'RC', '2026-10-03')).toBe('RC-202610-0001');
    expect(s.next('c1', 'TI', '2026-10-31')).toBe('TI-202610-0003');
  });
  it('round-trips through JSON', () => {
    const s = new SeriesAllocator(); s.next('c1', 'TI', '2026-10-01');
    const t = new SeriesAllocator(s.toJSON());
    expect(t.next('c1', 'TI', '2026-10-02')).toBe('TI-202610-0002');
  });
});
