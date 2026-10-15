'use client';
import { useInfiniteQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { PlusIcon } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useMe } from '@/app-shell/useMe';
import type { DocDescriptor } from '@/domain/descriptors';
import { routesOf } from '@/domain/descriptors';
import type { DocStatus, DocSummary, Page } from '@/domain/types';
import { ApiError } from '@/lib/api/client';
import { endpoints } from '@/lib/api/endpoints';
import { todayIso } from '@/lib/format';
import { qk } from '@/lib/query/keys';
import { cn } from '@/lib/utils';
import { EmptyState } from '../states/EmptyState';
import { ErrorState } from '../states/ErrorState';
import { ForbiddenState } from '../states/ForbiddenState';
import { LoadingState } from '../states/LoadingState';
import { NotAvailableState } from '../states/NotAvailableState';
import { BulkBar, type BulkAction } from './BulkBar';
import { SavedViews, type SavedView } from './SavedViews';
import { StatusChip } from './StatusChip';
import { useDocListParams, type DocListFilters } from './useDocListParams';

export type { BulkAction, SavedView };
export interface DocListColumn { key: string; header: string; align?: 'start' | 'end'; cell: (row: DocSummary) => ReactNode }
export interface DocListProps { descriptor: DocDescriptor; columns: DocListColumn[]; savedViews: SavedView[]; bulkActions: BulkAction[] }

const PAGE = 25;
const STATUSES: DocStatus[] = ['draft', 'pending', 'approved', 'issued', 'partly_settled', 'settled', 'cancelled', 'replaced'];
const DAY = 86_400_000;
/** A saved view's status list that is not one status: the select needs a matching <option> or it shows "all" while filtering. */
const OUTSTANDING_STATUS = 'issued,partly_settled';

/** Days past the due date for a document that still owes money; 0 when not overdue. Derived, never stored. */
export function daysOverdue(r: DocSummary, today = todayIso()): number {
  if (!r.dueDate || !r.outstanding || !(Number(r.outstanding) > 0) || (r.status !== 'issued' && r.status !== 'partly_settled')) return 0;
  return Math.max(0, Math.floor((Date.parse(today) - Date.parse(r.dueDate)) / DAY));
}

const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement && (['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) || t.isContentEditable);

export function DocList({ descriptor: d, columns, savedViews, bulkActions }: DocListProps) {
  const t = useTranslations('docList');
  const ts = useTranslations('state');
  const tStatus = useTranslations('status');
  const tc = useTranslations('common');
  const td = useTranslations(`docTypes.${d.type}`);
  const router = useRouter();
  const { me, isError: meFailed, error: meError, refetch: refetchMe } = useMe();
  const { filters, setFilters, patch } = useDocListParams();
  const qc = useQueryClient();
  const [sel, setSel] = useState<{ scope: string; ids: Set<string> }>({ scope: '', ids: new Set() });
  const searchRef = useRef<HTMLInputElement>(null);
  const debounce = useRef<ReturnType<typeof setTimeout>>(undefined);
  // The box is controlled by local text so back / forward (a new ?q=) can restore it; `pushed` is the last q this box wrote to the URL.
  const pushed = useRef(filters.q ?? '');
  const [text, setText] = useState(filters.q ?? '');
  useEffect(() => {
    if ((filters.q ?? '') === pushed.current) return;
    clearTimeout(debounce.current);
    pushed.current = filters.q ?? '';
    setText(pushed.current);
  }, [filters.q]);

  const title = td('title');
  const routes = routesOf(d);
  const canCreate = !!me?.permissions.includes(d.permissions.create);
  const companyId = me?.activeCompanyId;

  // Selection belongs to one company + type + filter set; any change of that scope (company switch included) empties it.
  const scope = JSON.stringify([companyId, d.type, filters]);
  if (sel.scope !== scope) setSel({ scope, ids: new Set() });
  const selected = sel.scope === scope ? sel.ids : new Set<string>();
  const setSelected = (u: Set<string> | ((s: Set<string>) => Set<string>)) =>
    setSel((c) => ({ scope, ids: typeof u === 'function' ? u(c.scope === scope ? c.ids : new Set()) : u }));

  const rangeBad = !!filters.from && !!filters.to && filters.from > filters.to;
  const wanted = {
    status: filters.status, q: filters.q, from: filters.from, to: filters.to, outstanding: filters.outstanding === 'positive' ? ('positive' as const) : undefined,
    overdue: filters.overdue === '1' ? ('1' as const) : undefined, agent: filters.agent === '1' ? ('1' as const) : undefined,
  };
  // An impossible date range is never sent: the last valid query stays on screen under the inline error.
  const [lastOk, setLastOk] = useState(rangeBad ? { ...wanted, from: undefined, to: undefined } : wanted);
  if (!rangeBad && JSON.stringify(lastOk) !== JSON.stringify(wanted)) setLastOk(wanted);
  const server = rangeBad ? lastOk : wanted;
  const q = useInfiniteQuery<Page<DocSummary>, Error, InfiniteData<Page<DocSummary>, string | undefined>, ReturnType<typeof qk.docs>, string | undefined>({
    queryKey: qk.docs(companyId ?? '', d.type, server),
    enabled: !!companyId,
    // A filter change keeps the old rows on screen (so the search box is not torn down mid-typing); another company's rows are never kept.
    placeholderData: (prev, prevQuery) => (prevQuery?.queryKey[0] === companyId ? prev : undefined),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => endpoints.listDocs(d.type, { ...server, limit: PAGE, cursor: pageParam }),
    getNextPageParam: (last) => last.nextCursor,
  });

  // Any filter change drops the selection; the query key changes too, so paging restarts from the first page.
  const apply = (next: DocListFilters, replaceAll = false) => {
    if (replaceAll) setFilters(next); else patch(next);
  };
  const hasFilters = Object.keys(filters).length > 0;
  const clearFilters = () => apply({}, true);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
      if (e.code === 'Slash') { e.preventDefault(); searchRef.current?.focus(); }
      else if (e.code === 'KeyN' && canCreate) { e.preventDefault(); router.push(routes.create); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [canCreate, router, routes.create]);
  useEffect(() => () => clearTimeout(debounce.current), []);

  // ---- state by cause: an error is never "no data" ----
  // /me failing (403 / 5xx) means the active company is unknown, so the list cannot load: classify that error the same way.
  if ((meFailed && !me) || (q.isError && !q.data)) {
    const e = meFailed && !me ? meError : q.error;
    if (e instanceof ApiError && e.problem.status === 403) return <ForbiddenState detail={e.problem.detail} permission={meFailed && !me ? undefined : d.permissions.read} />;
    if (e instanceof ApiError && e.problem.status === 404 && e.code === 'doc.type_not_available') return <NotAvailableState reason={d.vat === 'non-vat-only' ? 'nonVatOnly' : 'vatOnly'} />;
    return <ErrorState error={e} onRetry={() => void (meFailed && !me ? refetchMe() : q.refetch())} />;
  }
  if (!q.data) return <LoadingState />;

  const all = q.data.pages.flatMap((p) => p.items);
  const rows = all; // overdue / agent / outstanding are filtered by the server before paging
  const today = me?.businessDate ?? todayIso();
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const someSelected = rows.some((r) => selected.has(r.id));
  const toggle = (id: string, on: boolean) => setSelected((s) => { const n = new Set(s); if (on) n.add(id); else n.delete(id); return n; });
  const createLabel = (key: 'create' | 'emptyCreate') => (key === 'create' ? t('create', { title }) : ts('emptyCreate', { title }));
  const createLink = (key: 'create' | 'emptyCreate'): ReactNode => canCreate ? (
    <Button asChild><Link href={routes.create}><PlusIcon aria-hidden />{createLabel(key)}</Link></Button>
  ) : undefined;

  const field = 'h-(--ctl-h) rounded-lg border border-input bg-card px-3 text-body outline-none';
  return (
    <div className="flex flex-col gap-3">
      <h1 className="text-title font-semibold">{title}</h1>
      <SavedViews type={d.type} presets={savedViews} activeKey={filters.view} current={Object.fromEntries(Object.entries(filters).filter(([k]) => k !== 'view'))}
        onSelect={(v) => apply(v ? { ...v.params, view: v.key } : {}, true)} />
      <div className="flex flex-wrap items-end gap-2">
        <Input ref={searchRef} type="search" aria-label={t('searchLabel')} placeholder={t('searchPlaceholder')}
          value={text} className="max-w-72"
          onChange={(e) => {
            const v = e.target.value; setText(v); clearTimeout(debounce.current);
            debounce.current = setTimeout(() => { pushed.current = v; apply({ q: v || undefined }); }, 300);
          }} />
        <select aria-label={t('statusLabel')} className={field} value={filters.status ?? ''}
          onChange={(e) => apply({ status: e.target.value || undefined, outstanding: e.target.value === OUTSTANDING_STATUS ? 'positive' : undefined })}>
          <option value="">{t('statusAll')}</option>
          {STATUSES.map((s) => <option key={s} value={s}>{tStatus(s)}</option>)}
          <option value={OUTSTANDING_STATUS}>{t('views.outstanding')}</option>
          {filters.status && filters.status !== OUTSTANDING_STATUS && !STATUSES.includes(filters.status as DocStatus)
            ? <option value={filters.status}>{filters.status.split(',').map((s) => (STATUSES.includes(s as DocStatus) ? tStatus(s as DocStatus) : s)).join(' / ')}</option> : null}
        </select>
        <input type="date" aria-label={t('from')} className={field} value={filters.from ?? ''} onChange={(e) => apply({ from: e.target.value || undefined })} />
        <input type="date" aria-label={t('to')} className={field} value={filters.to ?? ''} onChange={(e) => apply({ to: e.target.value || undefined })} />
        {rangeBad ? <p role="alert" className="w-full text-small text-destructive">{t('rangeInvalid')}</p> : null}
        {hasFilters ? <Button variant="ghost" onClick={clearFilters}>{t('clearFilters')}</Button> : null}
        {rows.length > 0 ? <div className="ml-auto">{createLink('create')}</div> : null}
      </div>

      {selected.size > 0 ? (
        <BulkBar ids={[...selected]} actions={bulkActions} permissions={me?.permissions ?? []} onClear={() => setSelected(new Set())}
          onDone={() => void qc.invalidateQueries({ queryKey: [companyId, 'docs', d.type] })} />
      ) : null}

      {rows.length === 0 && !q.hasNextPage && !q.isError ? (
        hasFilters
          ? <EmptyState title={t('noMatchTitle')} body={t('noMatchBody')} action={<Button variant="outline" onClick={clearFilters}>{t('clearFilters')}</Button>} />
          : <EmptyState title={td('empty')} body={ts('emptyBody')} action={createLink('emptyCreate')} />
      ) : (
        <div className="overflow-hidden rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">
                  <Checkbox aria-label={t('selectAll')} checked={allSelected ? true : someSelected ? 'indeterminate' : false}
                    onCheckedChange={(v) => setSelected(v === true ? new Set(rows.map((r) => r.id)) : new Set())} />
                </TableHead>
                {columns.map((c) => <TableHead key={c.key} className={cn(c.align === 'end' && 'text-right')}>{c.header}</TableHead>)}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => {
                const od = daysOverdue(r, today);
                return (
                  <TableRow key={r.id} data-state={selected.has(r.id) ? 'selected' : undefined}>
                    <TableCell className="w-10">
                      <Checkbox aria-label={t('selectRowNamed', { name: r.number ?? `${tc('draftNoNumber')} ${r.partyName}` })} checked={selected.has(r.id)} onCheckedChange={(v) => toggle(r.id, v === true)} />
                    </TableCell>
                    {columns.map((c, i) => (
                      <TableCell key={c.key} className={cn(c.align === 'end' && 'text-right tabular-nums')}>
                        {i === 0 ? (
                          <span className="inline-flex items-center gap-2">
                            <Link href={routes.view(r.id)} className="text-primary hover:underline">{c.cell(r)}</Link>
                            {r.createdByAgent ? <span className="rounded-md bg-muted px-2 text-small text-muted-foreground">{t('agentChip')}</span> : null}
                            {od > 0 ? <><StatusChip status="overdue" /><span className="text-small text-muted-foreground tabular-nums">{t('overdueDays', { days: od })}</span></> : null}
                          </span>
                        ) : c.cell(r)}
                      </TableCell>
                    ))}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {q.isError ? <ErrorState error={q.error} onRetry={() => void (q.isFetchNextPageError ? q.fetchNextPage() : q.refetch())} /> : null}
      {q.hasNextPage ? (
        <div className="flex justify-center">
          <Button variant="outline" disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
            {q.isFetchingNextPage ? t('loadingMore') : t('loadMore')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
