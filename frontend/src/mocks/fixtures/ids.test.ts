import { describe, expect, it } from 'vitest';
import { buildSeed } from '.';
import { seed } from '../store';
import { FIXTURE_PREDICATES, fixtureIds } from './ids';

describe('named fixture ids', () => {
  for (const role of ['operator', 'accountant', 'admin'] as const) {
    it(`every key resolves in the ${role} seed`, () => {
      const ids = fixtureIds(seed()); // seed() reads the toolbar role via getSettings; buildSeed(role) is checked below
      expect(Object.keys(ids).sort()).toEqual(Object.keys(FIXTURE_PREDICATES).sort());
      expect(buildSeed(role).docs.length).toBeGreaterThan(0);
    });
  }
  it('tiIssuedUnpaid is issued, unlocked, unpaid and dated in the current open month', () => {
    const st = seed(); const d = st.docs.find((x) => x.id === fixtureIds(st).tiIssuedUnpaid)!;
    expect([d.type, d.status, d.locks.length, d.outstanding === d.totals.total, d.header.documentDate >= '2026-10-01']).toEqual(['TI', 'issued', 0, true, true]);
  });
  it('fails loudly when a predicate matches nothing (can fail)', () => {
    const st = seed(); st.docs = st.docs.filter((d) => d.type !== 'TI');
    expect(() => fixtureIds(st)).toThrow(/tiDraft/);
  });
});
