import { describe, expect, it } from 'vitest';
import { fixtureIds } from '@/mocks/fixtures/ids';
import { buildSeedState } from '@/mocks/store';
import { SCREENS } from './screens';

describe('screen index', () => {
  it('every fixture-routed screen resolves against the accountant seed (server-side, no toolbar)', () => {
    const ids = fixtureIds(buildSeedState());
    const keys = SCREENS.flatMap((s) => (typeof s.route === 'string' ? [] : [s.route.fixture]));
    expect(keys.length).toBeGreaterThan(5);
    for (const k of keys) expect(ids[k], k).toMatch(/^[\w-]+$/);
  });
  it('screen names are unique', () => expect(new Set(SCREENS.map((s) => s.name)).size).toBe(SCREENS.length));
});
