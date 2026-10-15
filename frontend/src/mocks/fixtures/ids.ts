import type { MockState } from '../store';
import { derivedLocks } from '../engine/locks';

type D = MockState['docs'][number];
const isTi = (d: D) => d.type === 'TI';

export type FixtureKey = 'tiDraft' | 'tiDraftNoTin' | 'tiIssuedUnpaid' | 'tiPartly' | 'tiSettled' | 'tiFilingLocked'
  | 'tiReplaced' | 'tiLong' | 'tiPeriodLocked' | 'rcTargetsA' | 'rcTargetsB'
  | 'qtDraft' | 'qtIssued' | 'qtRejected' | 'qtCancelled' | 'qtRevised' | 'nqtIssued'
  | 'soPartlyDelivered' | 'soClosed' | 'doDelivered' | 'nsoIssued' | 'ndoDelivered'
  | 'ivDraft' | 'ivIssuedUnpaid' | 'ivPartly' | 'ivSettled' | 'blVat' | 'blNonVat'
  | 'rcMulti' | 'rcNoCert' | 'rcDeposit' | 'nrcCashBill' | 'cnIssued' | 'dnIssued' | 'tiCreditedToZero'; // later tasks extend this union and FIXTURE_PREDICATES (one line each)

/** An issued, untouched TI of pc-01 (the multi-target receipt vector settles two of them). */
const rcTarget = (d: D, st: MockState) => isTi(d) && d.status === 'issued' && d.party?.id === 'pc-01' && d.outstanding === d.totals.total
  && !st.links.some((l) => l.active && l.to === d.id) && !derivedLocks(st, d).some((l) => l.kind !== 'period');
const firstRcTarget = (st: MockState) => st.docs.filter((x) => rcTarget(x, st)).map((x) => x.id).sort()[0];

/** A fixture that is one explicit seed document (fixtures/specs/<group>.ts), still in the state the fixture promises. */
const byId = (id: string, ok: (d: D) => boolean = () => true) => (d: D) => d.id === id && ok(d);

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
  rcTargetsA: (d, st) => rcTarget(d, st) && d.id === firstRcTarget(st),
  rcTargetsB: (d, st) => rcTarget(d, st) && d.id !== firstRcTarget(st), // the lowest id of the rest
  // issued, only the period lock, nothing linked to it: a correction (M2) has a plain reissue path
  tiPeriodLocked: (d, st) => isTi(d) && d.status === 'issued' && !d.id.startsWith('spike-') && !d.replacesId
    && derivedLocks(st, d).length === 1 && derivedLocks(st, d)[0].kind === 'period' && !st.links.some((l) => l.active && l.to === d.id),
  // S1 quotations
  qtDraft: byId('qt-d1', (d) => d.status === 'draft'),
  qtIssued: byId('qt-acc', (d) => d.status === 'issued' && !!d.marks?.accepted),
  qtRejected: byId('qt-rej', (d) => !!d.marks?.rejected),
  qtCancelled: byId('qt-can', (d) => d.status === 'cancelled'),
  qtRevised: byId('qt-r1', (d) => d.revision > 0),
  nqtIssued: byId('nqt-1', (d) => d.status === 'issued'),
  // S2 sales orders / delivery orders
  soPartlyDelivered: byId('so-part', (d) => d.status === 'issued'),
  soClosed: byId('so-closed', (d) => !!d.marks?.closed),
  doDelivered: byId('do-dlv', (d) => !!d.marks?.delivered),
  nsoIssued: byId('nso-1', (d) => d.status === 'issued'),
  ndoDelivered: byId('ndo-1', (d) => !!d.marks?.delivered),
  // S3 non-VAT invoices / billing statements
  ivDraft: byId('iv-d1', (d) => d.status === 'draft'),
  ivIssuedUnpaid: byId('iv-1', (d) => d.status === 'issued' && d.outstanding === d.totals.total),
  ivPartly: byId('iv-p1', (d) => d.status === 'partly_settled'),
  ivSettled: byId('iv-s1', (d) => d.status === 'settled'),
  blVat: byId('bl-1', (d) => d.status === 'issued'),
  blNonVat: byId('nbl-1', (d) => d.status === 'issued'),
  // S4 receipts
  rcMulti: byId('rc-multi', (d) => d.status === 'issued'),
  rcNoCert: byId('rc-nocert', (d) => d.status === 'issued' && !!d.allocations?.some((a) => a.wht && !a.certNumber)),
  rcDeposit: byId('rc-dep', (d) => d.status === 'issued'),
  nrcCashBill: byId('nrc-cash', (d) => d.status === 'issued'),
  // S5 credit / debit notes
  cnIssued: byId('cn-ret', (d) => d.status === 'issued' && d.lines.length === 2),
  dnIssued: byId('dn-1', (d) => d.status === 'issued'),
  tiCreditedToZero: byId('ti-046', (d) => d.status === 'issued' && d.outstanding === '0.00'), // credited in full by cn-full, never settled
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
