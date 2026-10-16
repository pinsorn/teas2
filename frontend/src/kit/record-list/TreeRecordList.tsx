'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDownIcon, ChevronRightIcon, PlusIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useCompanyEpoch } from '@/app-shell/useCompanyEpoch';
import { useMe } from '@/app-shell/useMe';
import type { RecordColumn, RecordDescriptor, RecordRow } from '@/domain/records';
import { ApiError } from '@/lib/api/client';
import { endpoints } from '@/lib/api/endpoints';
import { cn } from '@/lib/utils';
import { RecordFormDialog } from '../record-form/RecordForm';
import { EmptyState } from '../states/EmptyState';
import { ErrorState } from '../states/ErrorState';
import { ForbiddenState } from '../states/ForbiddenState';
import { LoadingState } from '../states/LoadingState';
import { useRecordListParams, type ActiveFilter } from './useRecordListParams';

export interface TreeNode { row: RecordRow; depth: number; hasChildren: boolean }

const text = (r: RecordRow, k: string) => (typeof r[k] === 'string' ? (r[k] as string).toLowerCase() : '');
/** The rows to show, depth-first (children by code under their parent). A row stays when it matches the search / active filter or has a descendant that does; a row whose parent is not in the data is a root. */
export function buildTree(rows: RecordRow[], f: { q: string; active: ActiveFilter }): TreeNode[] {
  const q = f.q.trim().toLowerCase(), byId = new Map(rows.map((r) => [String(r.id), r]));
  const parentOf = (r: RecordRow) => (typeof r.parent === 'string' && byId.has(r.parent) ? r.parent : undefined);
  const keep = new Set<string>();
  for (const r of rows) {
    if (f.active !== 'all' && r.active !== (f.active === 'true')) continue;
    if (q && !['code', 'name', 'nameEn'].some((k) => text(r, k).includes(q))) continue;
    for (let c: RecordRow | undefined = r, n = 0; c && !keep.has(String(c.id)) && n < 50; n++) { keep.add(String(c.id)); c = byId.get(parentOf(c) ?? ''); }
  }
  const kids = new Map<string | undefined, RecordRow[]>();
  for (const r of rows) if (keep.has(String(r.id))) kids.set(parentOf(r), [...(kids.get(parentOf(r)) ?? []), r]);
  const out: TreeNode[] = [];
  const walk = (parent: string | undefined, depth: number) => {
    for (const r of (kids.get(parent) ?? []).sort((a, b) => String(a.code).localeCompare(String(b.code), 'en', { numeric: true }))) {
      out.push({ row: r, depth, hasChildren: kids.has(String(r.id)) });
      walk(String(r.id), depth + 1);
    }
  };
  walk(undefined, 0);
  return out;
}

/** AC2: a record kind shown as a tree (the chart of accounts). Whole company chart in one fetch (the tree needs the parents), searched and filtered in the browser so a match keeps its ancestors; edit / switch on and off per row. Keyed by the active company. */
export function TreeRecordList(props: { descriptor: RecordDescriptor }) {
  return <TreeInner key={useCompanyEpoch()} {...props} />;
}

function TreeInner({ descriptor: d }: { descriptor: RecordDescriptor }) {
  const t = useTranslations();
  const tr = useTranslations('records.common');
  const ts = useTranslations('state');
  const qc = useQueryClient();
  const { me, isError: meFailed, error: meError, refetch: refetchMe } = useMe();
  const { params, patch } = useRecordListParams();
  const [form, setForm] = useState<{ row?: RecordRow }>();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [confirmOff, setConfirmOff] = useState<RecordRow>();
  const hintId = useId();
  const debounce = useRef<ReturnType<typeof setTimeout>>(undefined);
  const pushed = useRef(params.q);
  const [textQ, setTextQ] = useState(params.q);
  useEffect(() => {
    if (params.q === pushed.current) return;
    clearTimeout(debounce.current);
    pushed.current = params.q;
    setTextQ(params.q);
  }, [params.q]);
  useEffect(() => () => clearTimeout(debounce.current), []);

  const companyId = me?.activeCompanyId;
  const canManage = !!me?.permissions.includes(d.permissions.manage);
  const title = t(d.titleKey);
  const q = useQuery({
    queryKey: [companyId, 'records', d.kind, { tree: true }], enabled: !!companyId,
    queryFn: async () => { // every page: the tree needs the parents, whatever the page size
      const all: RecordRow[] = [];
      for (let cursor: string | undefined, page = 0; page < 50; page++) {
        const p = await endpoints.listRecords(d.kind, { active: 'all', limit: 100, cursor });
        all.push(...p.items);
        cursor = p.nextCursor;
        if (!cursor) break;
      }
      return all;
    },
  });
  const toggle = useMutation({
    mutationFn: (r: RecordRow) => endpoints.setRecordActive(d.kind, r.id, !r.active, r.version),
    onSuccess: () => qc.invalidateQueries({ queryKey: [companyId] }),
    onError: (e) => { if (e instanceof ApiError && e.code === 'record.version_conflict') void qc.invalidateQueries({ queryKey: [companyId] }); },
  });
  const nodes = useMemo(() => buildTree(q.data ?? [], { q: params.q, active: params.active }), [q.data, params.q, params.active]);

  if ((meFailed && !me) || (q.isError && !q.data)) {
    const e = meFailed && !me ? meError : q.error;
    if (e instanceof ApiError && e.problem.status === 403) return <ForbiddenState detail={e.problem.detail} permission={meFailed && !me ? undefined : d.permissions.read} />;
    return <ErrorState error={e} onRetry={() => void (meFailed && !me ? refetchMe() : q.refetch())} />;
  }
  if (!q.data) return <LoadingState />;

  // a collapsed header hides everything below it; a search shows every match whatever is collapsed
  const hidden = new Set<string>();
  const shown = params.q ? nodes : nodes.filter((n) => {
    const p = typeof n.row.parent === 'string' ? n.row.parent : '';
    if (collapsed.has(p) || hidden.has(p)) { hidden.add(String(n.row.id)); return false; }
    return true;
  });
  const hasFilters = !!params.q || params.active !== 'true';
  const clearFilters = () => { clearTimeout(debounce.current); pushed.current = ''; setTextQ(''); patch({ q: '', active: 'true' }); };
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
    return String(v);
  };
  const flip = (id: string) => setCollapsed((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const err = toggle.error instanceof ApiError ? toggle.error : undefined;

  return (
    <div className="flex flex-col gap-3">
      <h1 className="text-title font-semibold">{title}</h1>
      <div className="flex flex-wrap items-end gap-2">
        <Input type="search" aria-label={tr('searchLabel')} placeholder={t(d.searchPlaceholderKey)} value={textQ} className="max-w-72"
          onChange={(e) => {
            const v = e.target.value; setTextQ(v); clearTimeout(debounce.current);
            debounce.current = setTimeout(() => { pushed.current = v; patch({ q: v }); }, 300);
          }} />
        <select aria-label={tr('activeLabel')} className={field} value={params.active} onChange={(e) => patch({ active: e.target.value as ActiveFilter })}>
          <option value="true">{tr('activeTrue')}</option>
          <option value="false">{tr('activeFalse')}</option>
          <option value="all">{tr('activeAll')}</option>
        </select>
        {hasFilters ? <Button variant="ghost" onClick={clearFilters}>{tr('clearFilters')}</Button> : null}
        {q.data.length > 0 ? <div className="ml-auto">{createButton}</div> : null}
      </div>
      {toggle.isError ? (
        <Alert variant="destructive" role="alert">
          <AlertTitle>{err ? err.problem.title : tr('formError')}</AlertTitle>
          {err?.problem.detail ? <AlertDescription className="text-foreground!">{err.problem.detail}</AlertDescription> : null}
        </Alert>
      ) : null}

      {q.data.length === 0 ? <EmptyState title={t(`records.${d.kind}.empty`)} body={ts('emptyBody')} action={createButton} />
        : shown.length === 0 ? <EmptyState title={tr('noMatchTitle')} body={tr('noMatchBody')} action={<Button variant="outline" onClick={clearFilters}>{tr('clearFilters')}</Button>} />
        : (
          <div className="overflow-x-auto rounded-lg border bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  {d.columns.map((c) => <TableHead key={c.key}>{t(c.labelKey)}</TableHead>)}
                  <TableHead><span className="sr-only">{t('records.account.actions')}</span></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {shown.map(({ row: r, depth, hasChildren }) => (
                  <TableRow key={r.id} className={cn(r.postable === false && 'font-semibold', !r.active && 'text-muted-foreground')}>
                    {d.columns.map((c, i) => (
                      <TableCell key={c.key}>
                        {i === 0 ? (
                          <span className="flex items-center gap-1" style={{ paddingInlineStart: `${depth * 1.25}rem` }}>
                            {hasChildren
                              ? <Button type="button" variant="ghost" size="icon-xs" aria-expanded={!collapsed.has(String(r.id)) || !!params.q}
                                  aria-label={t(collapsed.has(String(r.id)) ? 'records.account.expand' : 'records.account.collapse', { code: String(r.code) })} onClick={() => flip(String(r.id))}>
                                  {collapsed.has(String(r.id)) ? <ChevronRightIcon aria-hidden /> : <ChevronDownIcon aria-hidden />}
                                </Button>
                              : <span aria-hidden className="inline-block size-6" />}
                            {canManage
                              ? <button type="button" className="text-primary tabular-nums hover:underline" onClick={() => setForm({ row: r })}>{cell(c, r)}</button>
                              : <span className="tabular-nums">{cell(c, r)}</span>}
                          </span>
                        ) : cell(c, r)}
                      </TableCell>
                    ))}
                    <TableCell className="text-right">
                      <Button type="button" variant="outline" size="sm" disabled={!canManage || toggle.isPending}
                        onClick={() => { toggle.reset(); if (r.active) setConfirmOff(r); else toggle.mutate(r); }}>{r.active ? tr('deactivate') : tr('activate')}</Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

      {confirmOff ? (
        <AlertDialog open onOpenChange={(o) => { if (!o) setConfirmOff(undefined); }}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{tr('deactivateTitle', { name: `${String(confirmOff.code)} ${String(confirmOff.name)}` })}</AlertDialogTitle>
              <AlertDialogDescription>{tr('deactivateBody')}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{tr('cancel')}</AlertDialogCancel>
              <AlertDialogAction onClick={() => toggle.mutate(confirmOff)}>{tr('deactivate')}</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
      {form ? <RecordFormDialog descriptor={d} row={form.row} onSaved={() => setForm(undefined)} onClose={() => setForm(undefined)} /> : null}
    </div>
  );
}
