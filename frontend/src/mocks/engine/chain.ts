import type { ChainEdge, ChainGraph, ChainNode, Doc, DocLine, Qty } from '@/domain/types';
import type { MockState } from '../store';
import { fromSatang, toSatang } from './money';
import { MockError } from './log';

/** Quantities as integers scaled by 10^4 (no float arithmetic). */
export const q4 = (q: Qty): number => {
  if (!/^\d+(\.\d{1,4})?$/.test(q)) throw new MockError(422, 'doc.invalid_qty', `จำนวนไม่ถูกต้อง: ${q}`);
  const [i, f = ''] = q.split('.');
  return Number(i) * 10000 + Number((f + '0000').slice(0, 4));
};
export const fmtQ = (n: number): Qty => `${Math.trunc(n / 10000)}.${String(n % 10000).padStart(4, '0')}`.replace(/\.?0+$/, '');

/** Quantity of `line` (of `src`) already taken by active conversions (drafts included: they reserve quantity). */
export function consumed(st: MockState, src: Doc, line: DocLine): number {
  const idx = src.lines.findIndex((l) => l.id === line.id);
  let sum = 0;
  for (const e of st.links) {
    if (e.kind !== 'converted_from' || e.to !== src.id || !e.active) continue;
    const t = st.docs.find((d) => d.id === e.from);
    if (!t) continue;
    const byRef = t.lines.some((l) => l.sourceLineId); // seeded chains carry no per-line reference: match by position
    t.lines.forEach((tl, i) => { if (byRef ? tl.sourceLineId === line.id : i === idx) sum += q4(tl.qty); });
  }
  return sum;
}

function progressOf(st: MockState, d: Doc): string | undefined {
  if (d.type === 'QT' || d.type === 'SO' || d.type === 'DO') { // converted / ordered
    const ordered = d.lines.reduce((a, l) => a + q4(l.qty), 0);
    const delivered = d.lines.reduce((a, l) => a + consumed(st, d, l), 0);
    return `${fmtQ(delivered)}/${fmtQ(ordered)}`;
  }
  if (d.type === 'TI' && d.outstanding !== undefined) {
    const paid = st.links.filter((l) => l.kind === 'settles' && l.to === d.id && l.active).reduce((a, l) => a + toSatang(l.amount ?? '0.00'), 0);
    return `ชำระแล้ว ${fromSatang(paid)} / ${d.totals.total}`;
  }
  return undefined;
}

/** Everything connected to the document, walking links in both directions (inactive edges are kept, flagged). */
export function buildChain(st: MockState, id: string): ChainGraph {
  if (!st.docs.some((d) => d.id === id)) throw new MockError(404, 'doc.not_found', 'ไม่พบเอกสาร');
  const seen = new Set([id]);
  const queue = [id];
  const edges: ChainEdge[] = [];
  const done = new Set<object>();
  while (queue.length) {
    const cur = queue.shift()!;
    for (const e of st.links) {
      if ((e.from !== cur && e.to !== cur) || done.has(e)) continue;
      done.add(e);
      const { companyId, ...edge } = e; void companyId;
      edges.push(edge);
      const other = e.from === cur ? e.to : e.from;
      if (!seen.has(other)) { seen.add(other); queue.push(other); }
    }
  }
  const nodes: ChainNode[] = [...seen].flatMap((nid) => {
    const d = st.docs.find((x) => x.id === nid);
    if (!d) return [];
    const progress = progressOf(st, d);
    return [{ id: d.id, type: d.type, number: d.number, status: d.status, total: d.totals.total, ...(progress ? { progress } : {}) }];
  });
  return { rootId: id, nodes, edges };
}
