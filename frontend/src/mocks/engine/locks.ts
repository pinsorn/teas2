import type { Lock } from '@/domain/types';
import type { MockState } from '../store';

/** The locks a document READS with (single derivation: the doc GET handler and the fixture predicates both call this).
 *  F4 adds the period lock, TX1 the filing lock. */
export function derivedLocks(_st: MockState, d: { locks: Lock[] }): Lock[] {
  void _st;
  return d.locks;
}
