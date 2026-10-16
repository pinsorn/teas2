import type { Actor, Allocation, DocHeader, DocLine, DocType, IsoDate, Qty } from '@/domain/types';
import { approve, approvalRequired, submit } from '../engine/approval';
import { approveAndIssue, cancel, convert, createDraft, issue, updateDraft } from '../engine/commands';
import { withFixedClock } from '../engine/log';
import type { MockState } from '../store';
import { USER } from './documents';

export interface SeedSpec {
  id: string; type: DocType; companyId: string; date: IsoDate; partyId?: string; lines: DocLine[];
  header?: Partial<DocHeader>; allocations?: Allocation[]; status: 'draft' | 'pending' | 'approved' | 'issued' | 'cancelled';
  convertFrom?: { id: string; lines: { sourceLineId: string; qty: Qty }[] }; by?: Actor; after?: (st: MockState) => void;
}

/** Executes specs in (date, list order) through createDraft / convert / issue / cancel with a pinned clock
 *  (`${date}T10:00:00+07:00` + 20 s per earlier spec of the same date + 1 s per stamp). Throws on any engine error, naming the spec id.
 *  History is issued as of its own date, so the closed-period and future-date refusals do not apply while the clock is pinned. */
export function runSeed(st: MockState, specs: SeedSpec[]): void {
  const perDate = new Map<string, number>();
  const ordered = specs.map((s, i) => ({ s, i })).sort((a, b) => a.s.date.localeCompare(b.s.date) || a.i - b.i);
  for (const { s } of ordered) {
    const ord = perDate.get(s.date) ?? 0;
    perDate.set(s.date, ord + 1);
    const at = new Date(Date.parse(`${s.date}T10:00:00+07:00`) + 20_000 * ord).toISOString();
    try {
      withFixedClock(at, () => runOne(st, s));
    } catch (e) {
      throw new Error(`seed spec ${s.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

function runOne(st: MockState, s: SeedSpec): void {
  const actor = s.by ?? USER;
  const header: DocHeader = { partyId: s.partyId, documentDate: s.date, ...(s.convertFrom ? {} : { priceIncludesVat: false }), ...s.header };
  let d = s.convertFrom
    ? convert(st, s.convertFrom.id, s.type, s.convertFrom.lines, actor, { id: s.id })
    : createDraft(st, s.companyId, s.type, { header, lines: s.lines, ...(s.allocations ? { allocations: s.allocations } : {}) }, actor, `seed-${s.id}`, { id: s.id });
  if (s.convertFrom) d = updateDraft(st, d.id, { header: { ...d.header, ...header, partyId: header.partyId ?? d.header.partyId }, lines: d.lines }, d.version, actor);
  if (s.status === 'pending' || s.status === 'approved') { // waiting for (or past) approval: sent through the real commands, never written as a status
    d = submit(st, d.id, d.version, actor);
    if (s.status === 'approved') d = approve(st, d.id, d.version, actor);
  } else if (s.status !== 'draft') d = approvalRequired(st, s.companyId, s.type, d.totals.total) ? approveAndIssue(st, d.id, d.version, actor) : issue(st, d.id, d.version, actor); // a document the policy wants approved is approved by the seed's own user (self-approval is on)
  if (s.status === 'cancelled') cancel(st, d.id, d.version, 'OTHER', 'ยกเลิกในข้อมูลตั้งต้น', actor);
  s.after?.(st);
}
