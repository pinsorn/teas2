'use client';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState, type ReactNode } from 'react';
import { isForbidden, useMe } from '@/app-shell/useMe';
import { Button } from '@/components/ui/button';
import type { Doc, DocType } from '@/domain/types';
import { endpoints } from '@/lib/api/endpoints';
import { formatDateBE } from '@/lib/format';
import { qk } from '@/lib/query/keys';
import { ErrorState } from '../states/ErrorState';
import { ForbiddenState } from '../states/ForbiddenState';
import { LoadingState } from '../states/LoadingState';

/** Every version with its field-level diff; "ดูฉบับนี้" renders that snapshot through `renderPaper`. */
export function RevisionHistory({ type, id, renderPaper }: { type: DocType; id: string; renderPaper: (snapshot: Doc, revision: number) => ReactNode }) {
  const t = useTranslations('docView.revisions');
  const { me } = useMe();
  const [open, setOpen] = useState<number>();
  const q = useQuery({ queryKey: qk.revisions(me!.activeCompanyId, id), queryFn: () => endpoints.getRevisions(type, id) });
  if (q.isPending) return <LoadingState rows={3} />;
  if (q.error) return isForbidden(q.error) ? <ForbiddenState permission={`doc.${type}.read`} /> : <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  if (!q.data.length) return <p className="text-body text-muted-foreground">{t('empty')}</p>;
  const field = (path: string) => (['header.notes', 'header.reference', 'header.dueDate', 'header.documentDate', 'header.partyId'].includes(path) ? t(`field.${path}`) : path);
  return (
    <ol className="grid gap-5">
      {q.data.map((r) => (
        <li key={r.revision} className="grid gap-1.5">
          <div className="flex flex-wrap items-center gap-x-3">
            <h3 className="text-body font-medium">{r.revision === 0 ? t('first') : t('n', { n: r.revision })}</h3>
            <span className="text-small text-muted-foreground">{r.actor.name} · <time dateTime={r.at} className="tabular-nums">{formatDateBE(r.at.slice(0, 10))} {r.at.slice(11, 16)}</time></span>
            <Button size="sm" variant="ghost" aria-expanded={open === r.revision} onClick={() => setOpen(open === r.revision ? undefined : r.revision)}>
              {open === r.revision ? t('hide') : t('view')}
            </Button>
          </div>
          {r.reason ? <p className="text-small text-muted-foreground">{t('reason', { reason: r.reason })}</p> : null}
          {r.revision > 0 ? (r.diff.length ? (
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-body">
              {r.diff.map((c) => (
                <div key={c.path} className="contents">
                  <dt className="text-muted-foreground">{field(c.path)}</dt>
                  <dd><del className="text-muted-foreground">{c.before ?? t('blank')}</del> <ins className="no-underline font-medium">{c.after ?? t('blank')}</ins></dd>
                </div>
              ))}
            </dl>
          ) : <p className="text-small text-muted-foreground">{t('noChange')}</p>) : null}
          {open === r.revision ? renderPaper(r.snapshot, r.revision) : null}
        </li>
      ))}
    </ol>
  );
}
