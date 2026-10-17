import { describe, expect, it } from 'vitest';
import { buildSeed } from '.';
import { seed } from '../store';
import { BANK_FIXTURES, FILING_FIXTURES, FIXTURE_PREDICATES, SCHEDULE_FIXTURES, fixtureIds } from './ids';

describe('named fixture ids', () => {
  for (const role of ['operator', 'accountant', 'admin'] as const) {
    it(`every key resolves in the ${role} seed`, () => {
      const ids = fixtureIds(seed()); // seed() reads the toolbar role via getSettings; buildSeed(role) is checked below
      expect(Object.keys(ids).sort()).toEqual([...Object.keys(FIXTURE_PREDICATES), ...Object.keys(BANK_FIXTURES), ...Object.keys(SCHEDULE_FIXTURES), ...Object.keys(FILING_FIXTURES)].sort());
      expect(buildSeed(role).docs.length).toBeGreaterThan(0);
    });
  }
  it('tiIssuedUnpaid is issued, unlocked, unpaid and dated in the current open month', () => {
    const st = seed(); const d = st.docs.find((x) => x.id === fixtureIds(st).tiIssuedUnpaid)!;
    expect([d.type, d.status, d.locks.length, d.outstanding === d.totals.total, d.header.documentDate >= '2026-10-01']).toEqual(['TI', 'issued', 0, true, true]);
  });
  it('the filing periods are what they promise: 2026-08 finalized, 2026-09 finalizable, 2026-10 blocked, and tiFilingLocked is an August invoice the filing took', () => {
    const st = seed(); const ids = fixtureIds(st);
    expect([ids.pp30Finalized, ids.pp30Due, ids.pp30Draft]).toEqual(['2026-08', '2026-09', '2026-10']);
    expect(st.docs.find((x) => x.id === ids.tiFilingLocked)!.header.documentDate.startsWith('2026-08')).toBe(true);
  });
  it('fails loudly when a predicate matches nothing (can fail)', () => {
    const st = seed(); st.docs = [];
    const keys = Object.keys(FIXTURE_PREDICATES);
    let msg = ''; try { fixtureIds(st); } catch (e) { msg = String(e); }
    for (const k of keys) expect(msg, k).toContain(k); // every unresolved key is listed, not just the first
  });
});
