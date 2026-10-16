'use client';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { docViewHref } from '@/descriptors';
import { isForbidden, useMe } from '@/app-shell/useMe';
import type { ChainEdge, ChainGraph, ChainNode, DocType } from '@/domain/types';
import { endpoints } from '@/lib/api/endpoints';
import { formatTHB } from '@/lib/format';
import { qk } from '@/lib/query/keys';
import { cn } from '@/lib/utils';
import { StatusChip } from '../doc-list/StatusChip';
import { ApiError } from '@/lib/api/client';
import { ErrorState } from '../states/ErrorState';
import { ForbiddenState } from '../states/ForbiddenState';
import { LoadingState } from '../states/LoadingState';

interface TreeNode { node: ChainNode; edge?: ChainEdge; incoming: boolean; depth: number }

/** Walks the graph from the root; each document appears once (a cycle or diamond never repeats a node). */
function flatten(g: ChainGraph): TreeNode[] {
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const seen = new Set<string>();
  const out: TreeNode[] = [];
  // A document is labelled by its closest link to the root (e.g. "ออกแทนโดย" for a replacement): each node claims its direct
  // neighbours before any of them descends, so a replacement is not reached first through a copied conversion link.
  const expand = (id: string, depth: number) => {
    const next: TreeNode[] = [];
    for (const e of g.edges) {
      const incoming = e.to === id;
      const other = byId.get(incoming ? e.from : e.to);
      if ((e.from === id || incoming) && other && !seen.has(other.id)) { seen.add(other.id); next.push({ node: other, edge: e, incoming, depth: depth + 1 }); }
    }
    out.push(...next);
    for (const n of next) expand(n.node.id, depth + 1);
  };
  const root = byId.get(g.rootId);
  if (root) { seen.add(root.id); out.push({ node: root, incoming: false, depth: 0 }); expand(root.id, 0); }
  return out;
}

export function ChainPanel({ type, id }: { type: DocType; id: string }) {
  const t = useTranslations('docView');
  const { me } = useMe();
  const cid = me!.activeCompanyId;
  const q = useQuery({ queryKey: qk.chain(cid, type, id), queryFn: () => endpoints.getChain(type, id) });
  if (q.isPending) return <LoadingState rows={3} />;
  if (q.error) return isForbidden(q.error) ? <ForbiddenState permission={`doc.${type}.read`} detail={q.error instanceof ApiError ? q.error.problem.detail : undefined} /> : <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  // the region exists only once the graph is loaded
  return (
    <section aria-label={t('tabs.chain')} className="grid gap-2">
      {q.data.nodes.length <= 1 ? <p className="text-body text-muted-foreground">{t('chain.empty')}</p>
        : (
          <ul className="grid gap-1">
            {flatten(q.data).map(({ node, edge, incoming, depth }) => {
              const dead = node.status === 'cancelled' || node.status === 'replaced';
              const stl = node.type === 'STL'; // FN3: a settlement record (หักกลบ / ใช้เงินมัดจำ), not a document
              const href = stl ? `/finance/settlements/${node.id}` : docViewHref(node.type as DocType, node.id);
              const label = stl ? `${t('chain.settlement')} ${node.number ?? ''}`.trim() : `${node.type} ${node.number ?? ''}`.trim();
              return (
                <li key={node.id} style={{ marginInlineStart: `${Math.min(depth, 4) * 1.5}rem` }} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1">
                  {edge ? <span className="text-small text-muted-foreground">{t(`chain.rel.${edge.kind}.${incoming ? 'in' : 'out'}`)}</span> : null}
                  {node.id === id ? <span className={cn('font-medium', dead && 'line-through')}>{label} <span className="text-small font-normal text-muted-foreground">({t('chain.self')})</span></span>
                    : href ? <Link href={href} className={cn('text-primary hover:underline', dead && 'line-through')}>{label}</Link>
                    : <span className={cn(dead && 'line-through')}>{label}</span>}
                  {stl ? null : <StatusChip status={node.status} />}
                  <span className="tabular-nums text-small text-muted-foreground">{formatTHB(node.total)}</span>
                  {node.progress ? <span className="text-small text-muted-foreground">{node.progress}</span> : null}
                  {(edge && !edge.active) || (stl && dead) ? <span className="text-small text-muted-foreground">{t('chain.inactive')}</span> : null}
                </li>
              );
            })}
          </ul>
        )}
    </section>
  );
}
