'use client';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useMe } from '@/app-shell/useMe';
import { routesOf, type DocDescriptor } from '@/domain/descriptors';
import { LIVE } from '@/domain/doc-types';
import { endpoints } from '@/lib/api/endpoints';
import { formatDateBE, formatTHB } from '@/lib/format';
import { EmptyState } from '../states/EmptyState';
import { ErrorState } from '../states/ErrorState';
import { LoadingState } from '../states/LoadingState';

/** A note opened without its original: a CN / DN adjusts one issued tax invoice, a PCN / PDN one issued purchase bill, so choose it first (the editor then opens with that document's lines). */
export function AdjustPicker({ descriptor: d }: { descriptor: DocDescriptor }) {
  const ta = useTranslations('docEditor.adjust'), tv = useTranslations('docEditor.adjustVendor');
  const vendor = d.adjusts === 'PB';
  const t = (k: 'hint' | 'empty' | 'loadFailed' | 'pick', v?: { number: string }) => (vendor ? tv(k, v as never) : ta(k, v as never));
  const { me } = useMe();
  const q = useQuery({ queryKey: [me?.activeCompanyId ?? '', 'docs', d.adjusts, 'adjust-picker'], queryFn: () => endpoints.listDocs(d.adjusts!, { limit: 100 }), enabled: !!me });
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  if (!q.data) return <LoadingState />;
  const live = q.data.items.filter((i) => LIVE.includes(i.status));
  return (
    <section className="grid gap-4" aria-labelledby="adjust-title">
      <h1 id="adjust-title" className="text-title font-semibold">
        {vendor ? tv('title', { kind: tv(d.type === 'PCN' ? 'kindPcn' : 'kindPdn') }) : ta('title', { kind: ta(d.type === 'CN' ? 'kindCn' : 'kindDn') })}
      </h1>
      <p className="text-muted-foreground">{t('hint')}</p>
      {live.length === 0 ? <EmptyState title={t('empty')} /> : (
        <ul className="grid gap-2">
          {live.map((i) => (
            <li key={i.id}>
              <Link href={`${routesOf(d).create}?adjust=${i.id}`} aria-label={t('pick', { number: i.number ?? i.id })}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-card p-3 ring-1 ring-foreground/10 hover:bg-muted">
                <span className="tabular-nums font-medium">{i.number}</span>
                <span>{i.partyName}</span>
                <span className="text-muted-foreground tabular-nums">{formatDateBE(i.documentDate)}</span>
                <span className="tabular-nums">{formatTHB(i.total)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
