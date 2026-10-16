'use client';
import { useInfiniteQuery, type InfiniteData } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { isForbidden, useMe } from '@/app-shell/useMe';
import type { BankLine, Page } from '@/domain/types';
import { ApiError } from '@/lib/api/client';
import { endpoints } from '@/lib/api/endpoints';
import { formatDateBE, formatMoney } from '@/lib/format';
import { qk } from '@/lib/query/keys';
import { EmptyState } from '../states/EmptyState';
import { ErrorState } from '../states/ErrorState';
import { ForbiddenState } from '../states/ForbiddenState';
import { LoadingState } from '../states/LoadingState';

const STATUSES: BankLine['status'][] = ['unmatched', 'matched', 'ignored', 'posted'];
const field = 'h-(--ctl-h) rounded-lg border border-input bg-card px-3 text-body outline-none';

/** The statement lines of one account, newest first, filterable. `onImport` is the empty state's way forward (absent when the user cannot import). */
export function StatementLines({ accountId, onImport, actions, only, onShowAll }: {
  accountId: string; onImport?: () => void;
  /** FN2 workspace: a column of per-line actions (the reconcile tab). Without it the table is read-only. */
  actions?: (l: BankLine) => ReactNode;
  /** FN2: show this one line (the lock exit lands here, `?line=`); `onShowAll` leaves it. */
  only?: string; onShowAll?: () => void;
}) {
  const tr = useTranslations('bank.reconcile');
  const t = useTranslations('bank.lines');
  const ti = useTranslations('bank.import');
  const tc = useTranslations('records.common');
  const { me, error: meError, refetch: refetchMe } = useMe();
  const [status, setStatus] = useState<BankLine['status'] | ''>('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const params = { status: status || undefined, from: from || undefined, to: to || undefined, line: only };
  const filtered = !!(status || from || to || only);
  const companyId = me?.activeCompanyId ?? '';
  const q = useInfiniteQuery<Page<BankLine>, Error, InfiniteData<Page<BankLine>, string | undefined>, ReturnType<typeof qk.bankLines>, string | undefined>({
    queryKey: qk.bankLines(companyId, accountId, params), enabled: !!me,
    placeholderData: (prev, prevQuery) => (prevQuery?.queryKey[0] === companyId ? prev : undefined),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => endpoints.listBankLines(accountId, { ...params, limit: 50, cursor: pageParam }),
    getNextPageParam: (last) => last.nextCursor,
  });

  if (meError && !me) return <ErrorState error={meError} onRetry={() => void refetchMe()} />;
  if (q.isError && !q.data) {
    return isForbidden(q.error) ? <ForbiddenState permission="bank.read" detail={q.error instanceof ApiError ? q.error.problem.detail : undefined} /> : <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  }
  if (!q.data) return <LoadingState />;
  const rows = q.data.pages.flatMap((p) => p.items);
  const clear = () => { setStatus(''); setFrom(''); setTo(''); onShowAll?.(); };

  let body: ReactNode;
  if (rows.length === 0 && !q.hasNextPage) {
    body = filtered
      ? <EmptyState title={t('noMatch')} action={<Button variant="outline" onClick={clear}>{t('clear')}</Button>} />
      : <EmptyState title={t('empty')} action={onImport ? <Button onClick={onImport}>{ti('open')}</Button> : undefined} />;
  } else {
    body = (
      <div role="region" aria-label={t('title')} tabIndex={0} className="overflow-x-auto rounded-lg border bg-card [&_[data-slot=table-container]]:overflow-visible"> {/* this wrapper is the one scroller (keyboard-focusable) on a phone */}
        <Table>
          <TableHeader><TableRow>
            <TableHead>{t('date')}</TableHead><TableHead>{t('description')}</TableHead>
            <TableHead className="text-right">{t('in')}</TableHead><TableHead className="text-right">{t('out')}</TableHead>
            <TableHead className="text-right">{t('balance')}</TableHead><TableHead>{t('status')}</TableHead>
            {actions ? <TableHead>{tr('actions')}</TableHead> : null}
          </TableRow></TableHeader>
          <TableBody>
            {rows.map((l) => (
              <TableRow key={l.id}>
                <TableCell className="tabular-nums">{formatDateBE(l.date)}</TableCell>
                <TableCell>{l.description}</TableCell>
                <TableCell className="text-right tabular-nums">{l.amount.startsWith('-') ? '' : formatMoney(l.amount)}</TableCell>
                <TableCell className="text-right tabular-nums">{l.amount.startsWith('-') ? formatMoney(l.amount.slice(1)) : ''}</TableCell>
                <TableCell className="text-right tabular-nums">{formatMoney(l.balance)}</TableCell>
                <TableCell>
                  {t(`statuses.${l.status}`)}{l.locked ? <span className="ms-2 rounded border px-1.5 text-small">{tr('locked')}</span> : null}
                  {actions && l.matches?.length ? <span className="block text-small text-muted-foreground">{l.matches.map((m) => m.number).join(', ')}{l.diff ? ` · ${tr(`diff.${l.diff.role}`)} ${formatMoney(l.diff.amount)}` : ''}</span> : null}
                  {actions && l.transfer ? <span className="block text-small text-muted-foreground">{tr('transfer.tag')}</span> : null}
                  {actions && l.note ? <span className="block text-small text-muted-foreground">{l.note}</span> : null}
                </TableCell>
                {actions ? <TableCell><div className="flex flex-wrap gap-2">{actions(l)}</div></TableCell> : null}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    );
  }

  return (
    <section aria-labelledby="stmt-lines" className="grid gap-3">
      <h2 id="stmt-lines" className="text-section font-semibold">{t('title')}</h2>
      <div className="flex flex-wrap items-end gap-2">
        <select aria-label={t('filterStatus')} className={field} value={status} onChange={(e) => setStatus(e.target.value as BankLine['status'] | '')}>
          <option value="">{t('all')}</option>
          {STATUSES.map((s) => <option key={s} value={s}>{t(`statuses.${s}`)}</option>)}
        </select>
        <Input type="date" aria-label={t('from')} value={from} max={to || undefined} className="w-auto" onChange={(e) => setFrom(e.target.value)} />
        <Input type="date" aria-label={t('to')} value={to} min={from || undefined} className="w-auto" onChange={(e) => setTo(e.target.value)} />
        {filtered ? <Button variant="ghost" onClick={clear}>{t('clear')}</Button> : null}
      </div>
      {only ? (
        <p className="flex flex-wrap items-center gap-2 text-small text-muted-foreground" role="status">{tr('onlyLine')}<Button variant="ghost" size="sm" onClick={() => onShowAll?.()}>{tr('showAll')}</Button></p>
      ) : null}
      {body}
      {q.isError ? <ErrorState error={q.error} onRetry={() => void (q.isFetchNextPageError ? q.fetchNextPage() : q.refetch())} /> : null}
      {q.hasNextPage ? (
        <div className="flex justify-center">
          <Button variant="outline" disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>{q.isFetchingNextPage ? tc('loadingMore') : tc('loadMore')}</Button>
        </div>
      ) : null}
    </section>
  );
}
