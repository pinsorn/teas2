'use client';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { NAV } from '@/app-shell/nav';
import { useMe } from '@/app-shell/useMe';
import type { ChainEdge, ChainGraph, ChainNode, DocType } from '@/domain/types';
import { endpoints } from '@/lib/api/endpoints';
import { formatTHB } from '@/lib/format';
import { qk } from '@/lib/query/keys';
import { cn } from '@/lib/utils';
import { StatusChip } from '../doc-list/StatusChip';
import { ErrorState } from '../states/ErrorState';
import { LoadingState } from '../states/LoadingState';

/** List route of a document type, from the nav (the non-VAT "invoices" entry shares the TI permission: prefer the plain one). */
const listOf = (type: DocType) => {
  const items = NAV.flatMap((g) => g.items).filter((i) => i.permission === `doc.${type}.read`);
  return (items.find((i) => !i.nonVatOnly) ?? items[0])?.href;
};
export const docHref = (type: DocType, id: string) => { const l = listOf(type); return l ? `${l}/${id}` : undefined; };

interface TreeNode { node: ChainNode; edge?: ChainEdge; incoming: boolean; depth: number }

/** Walks the graph from the root; each document appears once (a cycle or diamond never repeats a node). */
function flatten(g: ChainGraph): TreeNode[] {
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const seen = new Set<string>();
  const out: TreeNode[] = [];
  const visit = (id: string, depth: number, edge?: ChainEdge, incoming = false) => {
    const node = byId.get(id);
    if (!node || seen.has(id)) return;
    seen.add(id);
    out.push({ node, edge, incoming, depth });
    for (const e of g.edges) {
      if (e.from === id) visit(e.to, depth + 1, e, false);
      else if (e.to === id) visit(e.from, depth + 1, e, true);
    }
  };
  visit(g.rootId, 0);
  return out;
}

export function ChainPanel({ type, id }: { type: DocType; id: string }) {
  const t = useTranslations('docView');
  const { me } = useMe();
  const cid = me!.activeCompanyId;
  const q = useQuery({ queryKey: qk.chain(cid, id), queryFn: () => endpoints.getChain(type, id) });
  if (q.isPending) return <LoadingState rows={3} />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  // the region exists only once the graph is loaded
  return (
    <section aria-label={t('tabs.chain')} className="grid gap-2">
      {q.data.nodes.length <= 1 ? <p className="text-body text-muted-foreground">{t('chain.empty')}</p>
        : (
          <ul className="grid gap-1">
            {flatten(q.data).map(({ node, edge, incoming, depth }) => {
              const dead = node.status === 'cancelled' || node.status === 'replaced';
              const href = docHref(node.type, node.id);
              const label = `${node.type} ${node.number ?? ''}`.trim();
              return (
                <li key={node.id} style={{ marginInlineStart: `${Math.min(depth, 4) * 1.5}rem` }} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1">
                  {edge ? <span className="text-small text-muted-foreground">{t(`chain.rel.${edge.kind}.${incoming ? 'in' : 'out'}`)}</span> : null}
                  {node.id === id ? <span className={cn('font-medium', dead && 'line-through')}>{label} <span className="text-small font-normal text-muted-foreground">({t('chain.self')})</span></span>
                    : href ? <Link href={href} className={cn('text-primary hover:underline', dead && 'line-through')}>{label}</Link>
                    : <span className={cn(dead && 'line-through')}>{label}</span>}
                  <StatusChip status={node.status} />
                  <span className="tabular-nums text-small text-muted-foreground">{formatTHB(node.total)}</span>
                  {node.progress ? <span className="text-small text-muted-foreground">{node.progress}</span> : null}
                  {edge && !edge.active ? <span className="text-small text-muted-foreground">{t('chain.inactive')}</span> : null}
                </li>
              );
            })}
          </ul>
        )}
    </section>
  );
}
