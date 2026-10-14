import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildSample } from './sample';
import { contrast, hexOf, TILES } from './tokens';

const css = (id: string) => readFileSync(join(__dirname, `tokens-${id}.css`), 'utf8').toLowerCase();

describe.each(TILES)('tile $id', (t) => {
  it('every displayed swatch and chip colour exists in its css', () => {
    for (const hex of [...t.swatches.map((s) => s.hex), ...Object.values(t.chips).flat()]) expect(css(t.id), hex).toContain(hex.toLowerCase());
  });
  it('every listed pair meets its WCAG threshold', () => {
    for (const [f, b, min] of t.pairs) expect(contrast(hexOf(t, f), hexOf(t, b)), `${f}/${b}`).toBeGreaterThanOrEqual(min);
  });
  it('every status chip meets AA', () => {
    for (const [k, [fg, bg]] of Object.entries(t.chips)) expect(contrast(fg, bg), k).toBeGreaterThanOrEqual(4.5);
  });
});

describe('sample data', () => {
  it('10 list rows; net + vat = total on the invoice and per line', () => {
    const s = buildSample();
    expect(s.rows).toHaveLength(10);
    const sat = (m: string) => Math.round(Number(m) * 100);
    expect(sat(s.calc.totals.net) + sat(s.calc.totals.vat)).toBe(sat(s.calc.totals.total));
    for (const l of s.calc.lines) expect(sat(l.net) + sat(l.vat)).toBe(sat(l.total));
  });
});
