import type { MockState } from '../store';
import { LIVE } from '@/domain/doc-types';
import { derivedLocks } from '../engine/locks';

type D = MockState['docs'][number];
const isTi = (d: D) => d.type === 'TI';

export type FixtureKey = 'tiDraft' | 'tiAgentDraft' | 'tiDraftNoTin' | 'tiIssuedUnpaid' | 'tiPartly' | 'tiSettled' | 'tiFilingLocked'
  | 'tiReplaced' | 'tiLong' | 'tiPeriodLocked' | 'rcTargetsA' | 'rcTargetsB'
  | 'qtDraft' | 'qtIssued' | 'qtRejected' | 'qtCancelled' | 'qtRevised' | 'nqtIssued'
  | 'soPartlyDelivered' | 'soClosed' | 'doDelivered' | 'nsoIssued' | 'ndoDelivered'
  | 'ivDraft' | 'ivIssuedUnpaid' | 'ivPartly' | 'ivSettled' | 'blVat' | 'blNonVat'
  | 'poDraft' | 'poSent' | 'poPartlyBilled' | 'poClosed' | 'npoIssued'
  | 'rcMulti' | 'rcNoCert' | 'rcDeposit' | 'nrcCashBill' | 'cnIssued' | 'dnIssued' | 'tiCreditedToZero'
  | 'pbDraft' | 'pbIssuedUnpaid' | 'pb1Settled' | 'pbMixedVat' | 'pbFromPo' | 'pbCapex' | 'pbClaimLate' | 'pbIncomplete' | 'pcnIssued' | 'pdnIssued' | 'npbVatToCost'
  | 'pvMultiWt' | 'pvGrossUp' | 'pvForeign' | 'pvCancelled' | 'wtIssued' | 'wtCancelled'
  | 'exDraft' | 'exPending' | 'exApproved' | 'exUnpaid' | 'exPaid' | 'exForfeit' | 'nexIssued'; // later tasks extend this union and FIXTURE_PREDICATES (one line each)

/** An issued, untouched TI of pc-01 (the multi-target receipt vector settles two of them). */
const rcTarget = (d: D, st: MockState) => isTi(d) && d.status === 'issued' && d.party?.id === 'pc-01' && d.outstanding === d.totals.total
  && !st.links.some((l) => l.active && l.to === d.id) && !derivedLocks(st, d).some((l) => l.kind !== 'period');
const firstRcTarget = (st: MockState) => st.docs.filter((x) => rcTarget(x, st)).map((x) => x.id).sort()[0];

/** A fixture that is one explicit seed document (fixtures/specs/<group>.ts), still in the state the fixture promises. */
const byId = (id: string, ok: (d: D, st: MockState) => boolean = () => true) => (d: D, st: MockState) => d.id === id && ok(d, st);

/** Predicates evaluate the READ model (derivedLocks), never the stored row alone. */
export const FIXTURE_PREDICATES: Record<FixtureKey, (d: D, st: MockState) => boolean> = {
  tiDraft: (d) => isTi(d) && d.status === 'draft' && d.createdBy.kind === 'user',
  tiAgentDraft: (d) => isTi(d) && d.status === 'draft' && d.createdBy.kind === 'agent',
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
  // P1 purchase orders
  poDraft: byId('po-d1', (d) => d.status === 'draft'),
  poSent: byId('po-1', (d) => d.status === 'issued' && !!d.marks?.sent),
  poPartlyBilled: byId('po-part', (d) => d.status === 'issued'),
  poClosed: byId('po-closed', (d) => !!d.marks?.closed),
  npoIssued: byId('npo-1', (d) => d.status === 'issued'),
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
  // P2 purchase bills / vendor notes
  pbDraft: byId('pb-d1', (d) => d.status === 'draft'),
  pbIssuedUnpaid: byId('pb-claim-late', (d) => d.status === 'issued'), // issued, no voucher, no note against it (pb-1 is settled by pv-pay1: pb1Settled)
  pb1Settled: byId('pb-1', (d) => d.status === 'settled'), // rent with a vendor credit (pcn-1) against it, paid in full by pv-pay1 (P3)
  pbMixedVat: byId('pb-2', (d) => LIVE.includes(d.status)), // services + non-claimable entertainment, with a debit (pdn-1)
  pbFromPo: byId('pb-po', (d) => LIVE.includes(d.status) && !!d.lines[0]?.sourceLineId),
  pbCapex: byId('pb-capex', (d) => d.status === 'issued'),
  pbClaimLate: byId('pb-claim-late', (d) => d.status === 'issued' && d.header.claimPeriod === '2026-12'),
  pbIncomplete: byId('pb-incomplete', (d) => d.status === 'issued' && d.header.complete === false),
  pcnIssued: byId('pcn-1', (d) => d.status === 'issued'),
  pdnIssued: byId('pdn-1', (d) => d.status === 'issued'),
  npbVatToCost: byId('npb-1', (d) => LIVE.includes(d.status) && d.companyId === 'co-nonvat'), // settled by npv-1 (P3)
  // P3 payment vouchers / withholding certificates
  pvMultiWt: byId('pv-multi', (d, st) => d.status === 'issued' && st.links.filter((l) => l.active && l.kind === 'issues' && l.from === d.id).length === 2),
  pvGrossUp: byId('pv-gross', (d) => d.status === 'issued' && d.header.whtMode === 'grossup_always'),
  pvForeign: byId('pv-foreign', (d) => d.status === 'issued' && d.lines.some((l) => l.pnd36)),
  pvCancelled: byId('pv-can', (d) => d.status === 'cancelled'),
  wtIssued: (d, st) => d.type === 'WT' && d.status === 'issued' && st.links.some((l) => l.kind === 'issues' && l.from === 'pv-pay1' && l.to === d.id),
  wtCancelled: (d, st) => d.type === 'WT' && d.status === 'cancelled' && st.links.some((l) => l.kind === 'issues' && l.from === 'pv-can' && l.to === d.id),
  // P4 expense claims
  exDraft: byId('ex-d1', (d) => d.status === 'draft'),
  exPending: byId('ex-pend', (d) => d.status === 'pending'),
  exApproved: byId('ex-appr', (d) => d.status === 'approved'),
  exUnpaid: byId('ex-1', (d) => d.status === 'issued' && d.outstanding === d.totals.total), // issued by approve-and-issue, nothing paid, claims VAT on one line only
  exPaid: byId('ex-paid', (d) => d.status === 'settled'), // paid in full by pv-ex
  exForfeit: byId('ex-late', (d) => d.status === 'issued'), // the vendor invoice is past its claim window: VAT is cost
  nexIssued: byId('nex-1', (d) => d.status === 'issued' && d.companyId === 'co-nonvat'),
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
