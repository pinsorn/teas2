import { LIVE } from '@/domain/doc-types';
import type { DocStatus, Lock } from '@/domain/types';
import type { MockState } from '../store';
import { periodLock } from './periods';

/** The locks a document READS with (single derivation: the doc GET handler and the fixture predicates both call this).
 *  Stored locks (filing, settlement) plus the period lock, derived here and never stored. TX1 adds the filing lock. */
export function derivedLocks(st: MockState, d: { locks: Lock[]; companyId: string; status: DocStatus; header: { documentDate: string } }): Lock[] {
  const p = LIVE.includes(d.status) ? periodLock(st, d.companyId, d.header.documentDate) : undefined;
  return p ? [...d.locks, p] : d.locks;
}
