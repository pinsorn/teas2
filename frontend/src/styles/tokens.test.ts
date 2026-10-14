import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(__dirname, 'tokens.css'), 'utf8');
const tok = (name: string) => css.match(new RegExp(`${name}:\\s*(#[0-9a-f]{6})`, 'i'))![1];
const lum = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a: string, b: string) => {
  const [hi, lo] = [lum(tok(a)), lum(tok(b))].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

// docs/specs/SP1-design-system.md lists these ratios; keep both in step.
const TEXT: [string, string][] = [
  ['--color-ink', '--color-bg'], ['--color-ink', '--color-surface'], ['--color-ink-muted', '--color-bg'],
  ['--color-ink-muted', '--color-surface'], ['--color-ink-muted', '--color-subtle'], ['--color-brand-contrast', '--color-brand'], ['--color-brand-contrast', '--color-brand-hover'],
  ['--color-brand', '--color-bg'], ['--color-brand-ink', '--color-brand-soft'], ['--color-danger', '--color-surface'],
  ['--color-danger', '--color-bg'],
];
const CHIPS = ['draft', 'pending', 'approved', 'issued', 'partly', 'settled', 'cancelled', 'overdue'];

describe('tokens.css contrast', () => {
  it.each(TEXT)('%s on %s is AA text (4.5)', (f, b) => expect(ratio(f, b)).toBeGreaterThanOrEqual(4.5));
  it('control border and focus ring are 3:1 on the page and cards', () => {
    for (const bg of ['--color-bg', '--color-surface']) {
      expect(ratio('--color-control-border', bg)).toBeGreaterThanOrEqual(3);
      expect(ratio('--color-brand', bg)).toBeGreaterThanOrEqual(3);
    }
  });
  it.each(CHIPS)('status chip %s is AA', (k) => expect(ratio(`--color-status-${k}-fg`, `--color-status-${k}-bg`)).toBeGreaterThanOrEqual(4.5));
});
