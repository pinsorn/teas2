import type { Doc } from '@/domain/types';
import type { MockState } from '../../store';
import { companyEntries } from '../ledger';
import { toSatang } from '../money';

/** The revision of a document whose posting was in force on `asOf`, read from the STORED journal (an original or a correction dated on or
 *  before `asOf` and not reversed by then); undefined = none was. The entry names its revision (`revision`): the snapshot is the last
 *  revision before the document was next reposted (a T-class edit in place never reposts, so it reads the latest). No revision rows
 *  (a seeded document entered directly) = the document as stored.
 *  SCOPE: journals shaped [original, (reversal, correction)*, reversal?] - the open items' raising documents (TI / IV / PB / RC / PV / OB batch).
 *  An FA journal ([o1, o2, ...]; `assets.ts:357` appends a literal entry) does not fit: never call it there. */
export function revisionInForce(st: MockState, docId: string, asOf: string): Doc | undefined {
  const es = st.journals.find((j) => j.docId === docId)?.preview.entries ?? [];
  let k = -1;
  es.forEach((e, i) => { if (e.kind !== 'reversal' && e.date <= asOf) k = i; }); // the LAST posted in array (posting) order, not the latest date
  if (k < 0) return undefined;
  const undo = es.slice(k + 1).find((e) => e.kind === 'reversal'); // the reversal of entry k is the first reversal after it
  if (undo && undo.date <= asOf) return undefined;
  const r = es[k].revision ?? 0, next = es.slice(k + 1).find((e) => e.kind !== 'reversal')?.revision ?? Infinity;
  const snap = st.revisions.filter((x) => x.docId === docId && x.revision >= r && x.revision < next).at(-1)?.snapshot;
  const cur = st.docs.find((d) => d.id === docId);
  return snap ?? cur; // the stored doc is a Doc (plus companyId): no publicDoc import, no commands.ts dependency
}

/** Σ (debit - credit) in satang of the lines on account `code` dated on or before `asOf`, per (openItemId, line partyId); openItemId '' = a line naming no item. One pass over companyEntries. */
export function controlByItem(st: MockState, companyId: string, code: string, asOf: string): { openItemId: string; partyId: string; amount: number }[] {
  const m = new Map<string, { openItemId: string; partyId: string; amount: number }>();
  for (const e of companyEntries(st, companyId)) {
    if (e.date > asOf) continue;
    for (const l of e.lines) {
      if (l.accountCode !== code) continue;
      const openItemId = l.openItemId ?? '', partyId = l.partyId ?? '', key = `${openItemId}|${partyId}`, prev = m.get(key);
      const amount = toSatang(l.debit) - toSatang(l.credit);
      if (prev) prev.amount += amount; else m.set(key, { openItemId, partyId, amount });
    }
  }
  return [...m.values()];
}
