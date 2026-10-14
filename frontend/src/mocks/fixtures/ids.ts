import type { MockState } from '../store';
import { derivedLocks } from '../engine/locks';

type D = MockState['docs'][number];
const isTi = (d: D) => d.type === 'TI';

export type FixtureKey = 'tiDraft' | 'tiDraftNoTin' | 'tiIssuedUnpaid' | 'tiPartly' | 'tiSettled' | 'tiFilingLocked'
  | 'tiReplaced' | 'tiLong' | 'tiPeriodLocked'; // later tasks extend this union and FIXTURE_PREDICATES (one line each)

/** Predicates evaluate the READ model (derivedLocks), never the stored row alone. */
export const FIXTURE_PREDICATES: Record<FixtureKey, (d: D, st: MockState) => boolean> = {
  tiDraft: (d) => isTi(d) && d.status === 'draft' && d.createdBy.kind === 'user',
  tiDraftNoTin: (d) => isTi(d) && d.status === 'draft' && !!d.party?.vatRegistered && !d.party.taxId,
  tiIssuedUnpaid: (d, st) => isTi(d) && d.status === 'issued' && derivedLocks(st, d).length === 0
    && d.outstanding === d.totals.total && d.header.documentDate >= '2026-10-01',
  tiPartly: (d) => isTi(d) && d.status === 'partly_settled',
  tiSettled: (d, st) => isTi(d) && d.status === 'settled' && !derivedLocks(st, d).some((l) => l.kind === 'filing'),
  tiFilingLocked: (d, st) => isTi(d) && derivedLocks(st, d).some((l) => l.kind === 'filing'),
  tiReplaced: (d) => isTi(d) && d.status === 'replaced',
  tiLong: (d) => isTi(d) && d.id === 'spike-60',
  // issued, only the period lock, nothing linked to it: a correction (M2) has a plain reissue path
  tiPeriodLocked: (d, st) => isTi(d) && d.status === 'issued' && !d.id.startsWith('spike-') && !d.replacesId
    && derivedLocks(st, d).length === 1 && derivedLocks(st, d)[0].kind === 'period' && !st.links.some((l) => l.active && l.to === d.id),
};

/** Lowest id (string order) matching each predicate in the active seed; throws listing every unresolved key. */
export function fixtureIds(st: MockState): Record<FixtureKey, string> {
  const out: Partial<Record<FixtureKey, string>> = {};
  const missing: string[] = [];
  for (const [k, f] of Object.entries(FIXTURE_PREDICATES) as [FixtureKey, (typeof FIXTURE_PREDICATES)['tiDraft']][]) {
    const hit = st.docs.filter((d) => f(d, st)).map((d) => d.id).sort()[0];
    if (hit) out[k] = hit; else missing.push(k);
  }
  if (missing.length) throw new Error(`fixture ids unresolved: ${missing.join(', ')}`);
  return out as Record<FixtureKey, string>;
}
