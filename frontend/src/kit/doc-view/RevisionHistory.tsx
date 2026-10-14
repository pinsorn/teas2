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

const HEADER_FIELDS = ['notes', 'reference', 'dueDate', 'documentDate', 'partyId', 'dimensions', 'priceIncludesVat'];
const LINE_FIELDS = ['description', 'itemId', 'qty', 'unit', 'unitPrice', 'discountPct', 'taxCode', 'dimensions', 'sourceLineId', 'vatOverride'];
/** Diff path -> message key under `docView.revisions` (`lines.<id>.<field>` is resolved through `line.<field>` plus the line's position). */
export const FIELD_LABELS: Record<string, string> = {
  ...Object.fromEntries(HEADER_FIELDS.map((f) => [`header.${f}`, `fields.header.${f}`])),
  ...Object.fromEntries(LINE_FIELDS.map((f) => [`line.${f}`, `fields.line.${f}`])),
};

/** Every version with its field-level diff; "ดูฉบับนี้" renders that snapshot through `renderPaper`. */
export function RevisionHistory({ type, id, renderPaper }: { type: DocType; id: string; renderPaper: (snapshot: Doc, revision: number) => ReactNode }) {
  const t = useTranslations('docView.revisions');
  const { me } = useMe();
  const [open, setOpen] = useState<number>();
  const q = useQuery({ queryKey: qk.revisions(me!.activeCompanyId, type, id), queryFn: () => endpoints.getRevisions(type, id) });
  if (q.isPending) return <LoadingState rows={3} />;
  if (q.error) return isForbidden(q.error) ? <ForbiddenState permission={`doc.${type}.read`} /> : <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  if (!q.data.length) return <p className="text-body text-muted-foreground">{t('empty')}</p>;
  // Position of a line by id: this version's snapshot first, then any other (a removed line only exists in an older one).
  const lineNo = (id: string, own: Doc) => {
    for (const s of [own, ...q.data.map((r) => r.snapshot)]) { const i = s.lines.findIndex((l) => l.id === id); if (i >= 0) return i + 1; }
    return undefined;
  };
  const field = (path: string, own: Doc) => {
    if (FIELD_LABELS[path]) return t(FIELD_LABELS[path] as never);
    const m = /^lines\.([^.]+)(?:\.(.+))?$/.exec(path);
    if (!m) return path;
    const n = lineNo(m[1], own);
    const line = n ? t('lineN', { n }) : m[1];
    const key = m[2] && FIELD_LABELS[`line.${m[2]}`];
    return key ? t('lineField', { line, field: t(key as never) }) : m[2] ? t('lineField', { line, field: m[2] }) : line;
  };
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
                  <dt className="text-muted-foreground">{field(c.path, r.snapshot)}</dt>
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
