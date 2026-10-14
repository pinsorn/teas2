import { describe, expect, it } from 'vitest';
import { paginate } from './paginate';

const cap = { first: 300, next: 500, lastReserve: 120 };

describe('paginate', () => {
  it('one page when rows + reserve fit', () => {
    expect(paginate([50, 50, 50], cap)).toEqual([[0, 1, 2]]);
  });
  it('never splits a row and fills continuation pages', () => {
    const pages = paginate(Array(20).fill(40), cap);
    expect(pages.flat()).toEqual([...Array(20).keys()]);
    expect(pages[0].length).toBe(7); // 7 x 40 = 280 <= 300
  });
  it('keeps room for totals + signatures on the last page', () => {
    const pages = paginate([100, 100, 90], cap); // 290 fits the first page, but 290 + 120 > 300
    expect(pages.length).toBe(2);
    const last = pages[pages.length - 1].reduce((a, i) => a + [100, 100, 90][i], 0);
    expect(last + cap.lastReserve).toBeLessThanOrEqual(cap.next);
  });
  it('moves trailing rows onto the totals page instead of leaving it empty', () => {
    expect(paginate([100, 100, 90], cap)).toEqual([[0], [1, 2]]);
  });
  it('a single row taller than a page gets a page of its own', () => {
    expect(paginate([600], cap)).toEqual([[0], []]);
  });
});
