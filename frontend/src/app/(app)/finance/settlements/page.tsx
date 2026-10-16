'use client';
import { useInfiniteQuery, type InfiniteData } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useCompanyEpoch } from '@/app-shell/useCompanyEpoch';
import { isForbidden, useMe } from '@/app-shell/useMe';
import type { Page, SettlementRecord } from '@/domain/types';
import { ApiError } from '@/lib/api/client';
import { endpoints } from '@/lib/api/endpoints';
import { formatDateBE } from '@/lib/format';
import { qk } from '@/lib/query/keys';
import { Legs, SettlementForm } from '@/kit/settlement/SettlementForm';
import { EmptyState } from '@/kit/states/EmptyState';
import { ErrorState } from '@/kit/states/ErrorState';
import { ForbiddenState } from '@/kit/states/ForbiddenState';
import { LoadingState } from '@/kit/states/LoadingState';

const MANAGE = 'bank.manage';
const field = 'h-(--ctl-h) rounded-lg border border-input bg-card px-3 text-body outline-none';

/** FN3: every settlement record of the company (deposits and prepayments applied, netting, write-offs), newest first. Anyone who can read the bank reads it; posting needs bank.manage. */
export default function SettlementsPage() {
  return <SettlementsInner key={useCompanyEpoch()} />;
}

function SettlementsInner() {
  const t = useTranslations('settlement');
  const tl = useTranslations('settlement.list');
  const tc = useTranslations('records.common');
  const router = useRouter();
  const hintId = useId();
  const { me, isPending: mePending, error: meError, refetch: refetchMe } = useMe();
  const [text, setText] = useState('');
  const [status, setStatus] = useState<'' | SettlementRecord['status']>('');
  const [creating, setCreating] = useState(false);
  const params = { q: text.trim() || undefined, status: status || undefined };
  const companyId = me?.activeCompanyId ?? '';
  const q = useInfiniteQuery<Page<SettlementRecord>, Error, InfiniteData<Page<SettlementRecord>, string | undefined>, ReturnType<typeof qk.settlements>, string | undefined>({
    queryKey: qk.settlements(companyId, params), enabled: !!me,
    placeholderData: (prev, prevQuery) => (prevQuery?.queryKey[0] === companyId ? prev : undefined),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => endpoints.listSettlements({ ...params, limit: 25, cursor: pageParam }),
    getNextPageParam: (last) => last.nextCursor,
  });
  if (meError) return <ErrorState error={meError} onRetry={() => void refetchMe()} />;
  if (mePending || (!q.data && !q.isError)) return <LoadingState />;
  if (q.isError && !q.data) return isForbidden(q.error) ? <ForbiddenState permission="bank.read" detail={q.error instanceof ApiError ? q.error.problem.detail : undefined} /> : <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const canManage = me!.permissions.includes(MANAGE);
  const rows = q.data!.pages.flatMap((p) => p.items);
  const filtered = !!(params.q || params.status);
  const create = (
    <span className="inline-flex flex-col items-start gap-1">
      <Button disabled={!canManage} aria-describedby={canManage ? undefined : hintId} onClick={() => setCreating(true)}>{tl('new')}</Button>
      {canManage ? null : <span id={hintId} className="text-small text-muted-foreground">{t('needManage', { permission: MANAGE })}</span>}
    </span>
  );

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-3">
      <h1 className="text-title font-semibold">{tl('title')}</h1>
      <p className="text-muted-foreground">{tl('intro')} <Link href="/finance/deposits" className="text-primary underline">{tl('deposits')}</Link></p>
      <div className="flex flex-wrap items-end gap-2">
        <Input type="search" aria-label={tl('search')} placeholder={tl('searchPlaceholder')} value={text} className="max-w-72" onChange={(e) => setText(e.target.value)} />
        <select aria-label={tl('status')} className={field} value={status} onChange={(e) => setStatus(e.target.value as '' | SettlementRecord['status'])}>
          <option value="">{tl('all')}</option><option value="posted">{t('status.posted')}</option><option value="reversed">{t('status.reversed')}</option>
        </select>
        {filtered ? <Button variant="ghost" onClick={() => { setText(''); setStatus(''); }}>{tc('clearFilters')}</Button> : null}
        {rows.length > 0 ? <div className="ml-auto">{create}</div> : null}
      </div>
      {rows.length === 0 && !q.hasNextPage ? (
        filtered ? <EmptyState title={tc('noMatchTitle')} body={tc('noMatchBody')} action={<Button variant="outline" onClick={() => { setText(''); setStatus(''); }}>{tc('clearFilters')}</Button>} />
          : <EmptyState title={tl('empty')} body={tl('emptyBody')} action={create} />
      ) : (
        <div role="region" aria-label={tl('title')} tabIndex={0} className="overflow-x-auto rounded-lg border bg-card [&_[data-slot=table-container]]:overflow-visible">
          <Table>
            <TableHeader><TableRow>
              <TableHead>{tl('date')}</TableHead><TableHead>{tl('number')}</TableHead><TableHead>{tl('kind')}</TableHead><TableHead>{tl('party')}</TableHead>
              <TableHead>{tl('sources')}</TableHead><TableHead>{tl('targets')}</TableHead><TableHead>{tl('statusCol')}</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {rows.map((s) => (
                <TableRow key={s.id} className={s.status === 'reversed' ? 'text-muted-foreground' : undefined}>
                  <TableCell className="tabular-nums">{formatDateBE(s.date)}</TableCell>
                  <TableCell><Link href={`/finance/settlements/${s.id}`} className="text-primary hover:underline tabular-nums">{s.id.toUpperCase()}</Link></TableCell>
                  <TableCell>{t(`kinds.${s.kind}`)}</TableCell>
                  <TableCell>{s.targets[0]?.partyName ?? ''}{s.counterPartyId && s.sources[0]?.partyName ? ` ⇄ ${s.sources[0].partyName}` : ''}</TableCell>
                  <TableCell>{s.sources.length ? <Legs legs={s.sources} /> : <span aria-hidden className="text-muted-foreground">–</span>}</TableCell>
                  <TableCell><Legs legs={s.targets} /></TableCell>
                  <TableCell>{t(`status.${s.status}`)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {q.isError ? <ErrorState error={q.error} onRetry={() => void (q.isFetchNextPageError ? q.fetchNextPage() : q.refetch())} /> : null}
      {q.hasNextPage ? (
        <div className="flex justify-center"><Button variant="outline" disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>{q.isFetchingNextPage ? tc('loadingMore') : tc('loadMore')}</Button></div>
      ) : null}
      {creating ? <SettlementForm onClose={() => setCreating(false)} onPosted={(s) => router.push(`/finance/settlements/${s.id}`)} /> : null}
    </div>
  );
}
