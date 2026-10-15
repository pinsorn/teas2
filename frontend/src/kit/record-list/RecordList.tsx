'use client';
import { useInfiniteQuery, type InfiniteData } from '@tanstack/react-query';
import { PlusIcon } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useCompanyEpoch } from '@/app-shell/useCompanyEpoch';
import { useMe } from '@/app-shell/useMe';
import type { RecordColumn, RecordDescriptor, RecordRow } from '@/domain/records';
import type { Page } from '@/domain/types';
import { ApiError } from '@/lib/api/client';
import { endpoints } from '@/lib/api/endpoints';
import { formatDateBE, formatMoney } from '@/lib/format';
import { qk } from '@/lib/query/keys';
import { cn } from '@/lib/utils';
import { RecordFormDialog } from '../record-form/RecordForm';
import { EmptyState } from '../states/EmptyState';
import { ErrorState } from '../states/ErrorState';
import { ForbiddenState } from '../states/ForbiddenState';
import { LoadingState } from '../states/LoadingState';
import { NotAvailableState } from '../states/NotAvailableState';
import { useRecordListParams, type ActiveFilter } from './useRecordListParams';

const PAGE = 25;

/** Keyed by the active company: a switch drops the open dialog, the typed search and the other company's rows. */
export function RecordList(props: { descriptor: RecordDescriptor }) {
  return <RecordListInner key={useCompanyEpoch()} {...props} />;
}

function RecordListInner({ descriptor: d }: { descriptor: RecordDescriptor }) {
  const t = useTranslations();
  const tr = useTranslations('records.common');
  const ts = useTranslations('state');
  const { me, isError: meFailed, error: meError, refetch: refetchMe } = useMe();
  const { params, patch } = useRecordListParams();
  const [form, setForm] = useState<{ row?: RecordRow } | undefined>();
  const hintId = useId();
  const debounce = useRef<ReturnType<typeof setTimeout>>(undefined);
  // The box is controlled by local text so back / forward (a new ?q=) can restore it; `pushed` is the last q this box wrote to the URL.
  const pushed = useRef(params.q);
  const [text, setText] = useState(params.q);
  useEffect(() => {
    if (params.q === pushed.current) return;
    clearTimeout(debounce.current);
    pushed.current = params.q;
    setText(params.q);
  }, [params.q]);
  useEffect(() => () => clearTimeout(debounce.current), []);

  const companyId = me?.activeCompanyId;
  const canManage = !!me?.permissions.includes(d.permissions.manage);
  const title = t(d.titleKey);
  const server = { q: params.q || undefined, active: params.active };
  const q = useInfiniteQuery<Page<RecordRow>, Error, InfiniteData<Page<RecordRow>, string | undefined>, ReturnType<typeof qk.records>, string | undefined>({
    queryKey: qk.records(companyId ?? '', d.kind, server),
    enabled: !!companyId,
    // typing keeps the old rows on screen (the box is not torn down); another company's rows are never kept
    placeholderData: (prev, prevQuery) => (prevQuery?.queryKey[0] === companyId ? prev : undefined),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => endpoints.listRecords(d.kind, { ...server, limit: PAGE, cursor: pageParam }),
    getNextPageParam: (last) => last.nextCursor,
  });

  // ---- state by cause: an error is never "no data" ----
  if ((meFailed && !me) || (q.isError && !q.data)) {
    const e = meFailed && !me ? meError : q.error;
    if (e instanceof ApiError && e.problem.status === 403) return <ForbiddenState detail={e.problem.detail} permission={meFailed && !me ? undefined : d.permissions.read} />;
    if (e instanceof ApiError && e.code === 'record.not_available') return <NotAvailableState reason={d.vat === 'non-vat-only' ? 'nonVatOnly' : 'vatOnly'} />;
    return <ErrorState error={e} onRetry={() => void (meFailed && !me ? refetchMe() : q.refetch())} />;
  }
  if (!q.data) return <LoadingState />;

  const rows = q.data.pages.flatMap((p) => p.items);
  const hasFilters = !!params.q || params.active !== 'true';
  const clearFilters = () => { clearTimeout(debounce.current); pushed.current = ''; setText(''); patch({ q: '', active: 'true' }); };
  const createLabel = tr('create', { title });
  const createButton: ReactNode = (
    <span className="inline-flex flex-col items-start gap-1">
      <Button disabled={!canManage} aria-describedby={canManage ? undefined : hintId} onClick={() => setForm({})}><PlusIcon aria-hidden />{createLabel}</Button>
      {canManage ? null : <span id={hintId} className="text-small text-muted-foreground">{tr('needManage', { permission: d.permissions.manage })}</span>}
    </span>
  );
  const field = 'h-(--ctl-h) rounded-lg border border-input bg-card px-3 text-body outline-none';

  const cell = (c: RecordColumn, r: RecordRow): ReactNode => {
    const v = r[c.key];
    if (c.key === 'active') return v ? tr('activeTrue') : <span className="text-muted-foreground">{tr('activeFalse')}</span>;
    if (v === undefined || v === null || v === '') return <span aria-hidden className="text-muted-foreground">–</span>;
    if (c.optionKey) return t(`records.options.${c.optionKey}.${String(v)}`);
    if (c.kind === 'bool') return v ? tr('yes') : tr('no');
    if (c.kind === 'money') return formatMoney(String(v));
    if (c.kind === 'date') return formatDateBE(String(v));
    return String(v);
  };

  return (
    <div className="flex flex-col gap-3">
      <h1 className="text-title font-semibold">{title}</h1>
      <div className="flex flex-wrap items-end gap-2">
        <Input type="search" aria-label={tr('searchLabel')} placeholder={t(d.searchPlaceholderKey)} value={text} className="max-w-72"
          onChange={(e) => {
            const v = e.target.value; setText(v); clearTimeout(debounce.current);
            debounce.current = setTimeout(() => { pushed.current = v; patch({ q: v }); }, 300);
          }} />
        <select aria-label={tr('activeLabel')} className={field} value={params.active} onChange={(e) => patch({ active: e.target.value as ActiveFilter })}>
          <option value="true">{tr('activeTrue')}</option>
          <option value="false">{tr('activeFalse')}</option>
          <option value="all">{tr('activeAll')}</option>
        </select>
        {hasFilters ? <Button variant="ghost" onClick={clearFilters}>{tr('clearFilters')}</Button> : null}
        {rows.length > 0 ? <div className="ml-auto">{createButton}</div> : null}
      </div>

      {rows.length === 0 && !q.hasNextPage ? (
        hasFilters
          ? <EmptyState title={tr('noMatchTitle')} body={tr('noMatchBody')} action={<Button variant="outline" onClick={clearFilters}>{tr('clearFilters')}</Button>} />
          : <EmptyState title={t(`records.${d.kind}.empty`)} body={ts('emptyBody')} action={createButton} />
      ) : (
        <div className="overflow-hidden rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow>{d.columns.map((c) => <TableHead key={c.key} className={cn(c.align === 'end' && 'text-right')}>{t(c.labelKey)}</TableHead>)}</TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.id} className={cn(!r.active && 'text-muted-foreground')}>
                  {d.columns.map((c, i) => (
                    <TableCell key={c.key} className={cn(c.align === 'end' && 'text-right tabular-nums')}>
                      {i === 0
                        ? (d.detail
                          ? <Link href={`${d.basePath}/${r.id}`} className="text-primary hover:underline">{cell(c, r)}</Link>
                          : <button type="button" className="text-primary hover:underline" onClick={() => canManage && setForm({ row: r })}>{cell(c, r)}</button>)
                        : cell(c, r)}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {q.isError ? <ErrorState error={q.error} onRetry={() => void (q.isFetchNextPageError ? q.fetchNextPage() : q.refetch())} /> : null}
      {q.hasNextPage ? (
        <div className="flex justify-center">
          <Button variant="outline" disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>{q.isFetchingNextPage ? tr('loadingMore') : tr('loadMore')}</Button>
        </div>
      ) : null}

      {form ? <RecordFormDialog descriptor={d} row={form.row} onSaved={() => setForm(undefined)} onClose={() => setForm(undefined)} /> : null}
    </div>
  );
}
