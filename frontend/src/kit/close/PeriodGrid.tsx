'use client';
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { PeriodsView } from '@/domain/types';
import { formatDateBE } from '@/lib/format';

export const monthBE = (m: string) => formatDateBE(`${m}-01`).replace(/^\d+ /, '');

/** The twelve months of a year: status, who closed it and when, the reopen history, and the actions the order allows (check / close the next open month, view a closed one, reopen the latest closed one). */
export function PeriodGrid({ view, selected, canReopen, onSelect, onReopen }: { view: PeriodsView; selected?: string; canReopen: boolean; onSelect: (month: string) => void; onReopen: (month: string) => void }) {
  const t = useTranslations('periodClose.grid');
  return (
    <div role="region" aria-label={t('label')} tabIndex={0} className="overflow-x-auto rounded-lg border bg-card [&_[data-slot=table-container]]:overflow-visible">
      <Table>
        <TableHeader><TableRow><TableHead>{t('month')}</TableHead><TableHead>{t('status')}</TableHead><TableHead>{t('closed')}</TableHead><TableHead>{t('history')}</TableHead><TableHead><span className="sr-only">{t('actions')}</span></TableHead></TableRow></TableHeader>
        <TableBody>
          {view.months.map((m) => (
            <TableRow key={m.month} data-testid={`period-${m.month}`} data-state={m.month === selected ? 'selected' : undefined}>
              <TableCell className="tabular-nums">{monthBE(m.month)}</TableCell>
              <TableCell><Badge variant={m.status === 'closed' ? 'secondary' : 'outline'} data-testid={`status-${m.month}`}>{t(m.status === 'closed' ? 'statusClosed' : 'statusOpen')}</Badge></TableCell>
              <TableCell className="text-small">{m.closedAt ? `${formatDateBE(m.closedAt.slice(0, 10))}${m.closedBy ? ` · ${m.closedBy}` : ''}` : <span aria-hidden className="text-muted-foreground">–</span>}</TableCell>
              <TableCell className="text-small">
                {m.reopened.length === 0 ? <span aria-hidden className="text-muted-foreground">–</span> : (
                  <ul className="grid gap-0.5" aria-label={t('historyOf', { month: monthBE(m.month) })}>{m.reopened.map((r, i) => <li key={i}>{formatDateBE(r.at.slice(0, 10))} · {r.by} · {r.reason}</li>)}</ul>
                )}
              </TableCell>
              <TableCell className="whitespace-nowrap text-right">
                {m.status === 'open' && m.month === view.next.close ? <Button size="sm" variant={m.month === selected ? 'secondary' : 'outline'} onClick={() => onSelect(m.month)}>{t('check', { month: monthBE(m.month) })}</Button> : null}
                {m.status === 'closed' ? <Button size="sm" variant="ghost" onClick={() => onSelect(m.month)}>{t('view', { month: monthBE(m.month) })}</Button> : null}
                {m.month === view.next.reopen ? <Button size="sm" variant="outline" disabled={!canReopen} onClick={() => onReopen(m.month)}>{t('reopen', { month: monthBE(m.month) })}</Button> : null}
                {m.inClosedYear && m.status === 'closed' ? <span className="text-small text-muted-foreground">{t('yearClosed')}</span> : null}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
