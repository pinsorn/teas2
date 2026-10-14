import { describe, expect, it } from 'vitest';
import { NAV } from '@/app-shell/nav';
import en from './en.json';
import th from './th.json';

const keys = (o: object, p = ''): string[] =>
  Object.entries(o).flatMap(([k, v]) => (typeof v === 'object' ? keys(v, `${p}${k}.`) : [`${p}${k}`]));
const get = (o: object, path: string) => path.split('.').reduce<unknown>((a, k) => (a as Record<string, unknown>)?.[k], o);

describe('messages', () => {
  it('th and en have the same keys', () => expect(keys(en).sort()).toEqual(keys(th).sort()));
  it('contain no Bengali glyphs (U+0980-U+09FF)', () => expect(JSON.stringify(th) + JSON.stringify(en)).not.toMatch(/[ঀ-৿]/));
  it('every nav label exists in both languages', () => {
    for (const g of NAV) for (const l of [g.labelKey, ...g.items.map((i) => i.labelKey)]) {
      expect(typeof get(th, l), l).toBe('string');
      expect(typeof get(en, l), l).toBe('string');
    }
  });
  it('the test translator throws on a missing key (no silent key echo)', async () => {
    const { useTranslations } = await import('next-intl');
    expect(() => useTranslations('docList')('no.such.key')).toThrow();
  });
});
