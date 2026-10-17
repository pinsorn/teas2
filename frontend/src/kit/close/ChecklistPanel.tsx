'use client';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { ChecklistItem, PeriodMonth } from '@/domain/types';
import { ApiError } from '@/lib/api/client';
import { formatDateBE } from '@/lib/format';
import { monthBE } from './PeriodGrid';

/** One month's checklist as the server computed it. Blocking items link to where they are fixed; warnings are accepted with one explicit tick, and what was accepted is frozen on the closed month. */
export function ChecklistPanel({ month, period, items, canClose, isNext, acknowledged, onAcknowledged, pending, error, onClose }: {
  month: string; period?: PeriodMonth; items: ChecklistItem[]; canClose: boolean; isNext: boolean; acknowledged: boolean; onAcknowledged: (v: boolean) => void; pending: boolean; error: unknown; onClose: () => void;
}) {
  const t = useTranslations('periodClose.checklist');
  const tp = useTranslations('problem');
  const closed = period?.status === 'closed';
  const shown = closed ? period!.acknowledged : items;
  const warnings = items.filter((i) => i.severity === 'warning' && i.count > 0);
  return (
    <section aria-label={t('label', { month: monthBE(month) })} className="grid gap-3 rounded-lg border bg-card p-4" data-testid="checklist">
      <h2 className="text-section font-semibold">{closed ? t('closedTitle', { month: monthBE(month) }) : t('title', { month: monthBE(month) })}</h2>
      {closed ? <p className="text-small text-muted-foreground">{shown.length ? t('frozen') : t('noneAccepted')}</p> : null}
      <ul className="grid gap-2">
        {shown.map((i) => (
          <li key={i.code} data-testid={`check-${i.code}`} className="flex flex-wrap items-center gap-2">
            <Badge variant={i.severity === 'blocking' && i.count > 0 ? 'destructive' : 'outline'}>{t(`severity.${i.severity}`)}</Badge>
            <span>{i.labelTh}</span>
            <span className="font-medium tabular-nums" data-testid={`count-${i.code}`}>{t('count', { n: i.count })}</span>
            {!closed && i.count > 0 ? <Link href={i.href} className="text-primary underline">{t('fix')}</Link> : null}
            {i.count === 0 && !closed ? <span className="text-small text-muted-foreground">{t('ok')}</span> : null}
            {i.note ? <span className="text-small text-muted-foreground">{i.note}</span> : null}
          </li>
        ))}
      </ul>
      {closed ? (period!.closedAt ? <p className="text-small text-muted-foreground">{t('closedAt', { at: formatDateBE(period!.closedAt.slice(0, 10)) }) + (period!.closedBy ? ` · ${period!.closedBy}` : '')}</p> : null) : isNext ? (
        <div className="grid gap-2">
          {warnings.length ? (
            <label className="flex items-start gap-2 text-body">
              <input type="checkbox" className="mt-1 size-4" checked={acknowledged} onChange={(e) => onAcknowledged(e.target.checked)} />
              <span>{t('acknowledge', { n: warnings.length })}</span>
            </label>
          ) : null}
          {error ? (
            <Alert variant="destructive" role="alert"><AlertTitle>{error instanceof ApiError ? error.problem.title : tp('default')}</AlertTitle>
              <AlertDescription className="text-foreground!">{t('exitsAbove')}</AlertDescription></Alert>
          ) : null}
          <div><Button disabled={!canClose || pending} onClick={onClose}>{pending ? t('closing') : t('close', { month: monthBE(month) })}</Button>{canClose ? null : <span className="ms-2 text-small text-muted-foreground">{t('needClose')}</span>}</div>
        </div>
      ) : <p className="text-small text-muted-foreground">{t('notNext')}</p>}
    </section>
  );
}
