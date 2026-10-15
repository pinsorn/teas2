'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useId, useState, type ReactNode } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useCompanyEpoch } from '@/app-shell/useCompanyEpoch';
import { isForbidden, useMe } from '@/app-shell/useMe';
import { docViewHref } from '@/descriptors';
import { SETTLES } from '@/domain/doc-types';
import type { FieldSpec, RecordDescriptor, RecordRow } from '@/domain/records';
import type { DocStatus } from '@/domain/types';
import { ApiError } from '@/lib/api/client';
import { endpoints } from '@/lib/api/endpoints';
import { formatDateBE, formatMoney, formatTHB } from '@/lib/format';
import { qk } from '@/lib/query/keys';
import { cn } from '@/lib/utils';
import { StatusChip } from '../doc-list/StatusChip';
import { RecordFormDialog } from '../record-form/RecordForm';
import { isVisible } from '../record-form/fields';
import { EmptyState } from '../states/EmptyState';
import { ErrorState } from '../states/ErrorState';
import { ForbiddenState } from '../states/ForbiddenState';
import { LoadingState } from '../states/LoadingState';
import { NotFoundState } from '../states/NotFoundState';

/** Keyed by the active company: a switch drops the open tab, the edit dialog and the other company's record. */
export function RecordView(props: { descriptor: RecordDescriptor; id: string }) {
  return <RecordViewInner key={useCompanyEpoch()} {...props} />;
}

function RecordViewInner({ descriptor: d, id }: { descriptor: RecordDescriptor; id: string }) {
  const tr = useTranslations('records.view');
  const { me, isPending: mePending, error: meError, refetch: refetchMe } = useMe();
  const q = useQuery({ queryKey: qk.record(me?.activeCompanyId ?? '', d.kind, id), queryFn: () => endpoints.getRecord(d.kind, id), enabled: !!me });
  if (meError) return <ErrorState error={meError} onRetry={() => void refetchMe()} />;
  if (mePending || q.isPending) return <LoadingState />;
  if (q.error) {
    if (q.error instanceof ApiError && q.error.code === 'record.not_found') return <NotFoundState listHref={d.basePath} title={tr('notFoundTitle')} body={tr('notFoundBody')} />;
    return isForbidden(q.error)
      ? <ForbiddenState permission={d.permissions.read} detail={q.error instanceof ApiError ? q.error.problem.detail : undefined} />
      : <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  }
  return <Loaded d={d} row={q.data} permissions={me!.permissions} companyId={me!.activeCompanyId} />;
}

function Loaded({ d, row, permissions, companyId }: { d: RecordDescriptor; row: RecordRow; permissions: string[]; companyId: string }) {
  const t = useTranslations();
  const tr = useTranslations('records.view');
  const tc = useTranslations('records.common');
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [confirmOff, setConfirmOff] = useState(false);
  const hintId = useId();
  const canManage = permissions.includes(d.permissions.manage);
  const toggle = useMutation({
    mutationFn: () => endpoints.setRecordActive(d.kind, row.id, !row.active, row.version),
    onSuccess: () => qc.invalidateQueries({ queryKey: [companyId] }),
    onError: (e) => { if (e instanceof ApiError && e.code === 'record.version_conflict') void qc.invalidateQueries({ queryKey: [companyId] }); }, // stale: reload so a retry sends the current version
  });
  const need = canManage ? undefined : tc('needManage', { permission: d.permissions.manage });

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
      <header className="grid gap-2">
        <p className="text-small text-muted-foreground"><Link href={d.basePath} className="hover:underline">{t(d.titleKey)}</Link></p>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-h1 font-semibold">{String(row.name ?? row.code ?? row.id)}</h1>
          <Badge variant={row.active ? 'secondary' : 'outline'}>{row.active ? tc('activeTrue') : tc('activeFalse')}</Badge>
        </div>
        <dl className="grid grid-cols-[repeat(auto-fit,minmax(10rem,1fr))] gap-x-6 gap-y-2 text-body">
          <div><dt className="text-small text-muted-foreground">{tr('tin')}</dt><dd className="tabular-nums">{row.taxId ? String(row.taxId) : tc('none')}</dd></div>
          <div><dt className="text-small text-muted-foreground">{tr('branch')}</dt><dd className="tabular-nums">{row.branchCode ? String(row.branchCode) : tc('none')}</dd></div>
        </dl>
        <div className="flex flex-wrap items-start gap-2">
          <span className="inline-flex flex-col items-start gap-1">
            <Button disabled={!canManage} aria-describedby={need ? hintId : undefined} onClick={() => setEditing(true)}>{tc('edit')}</Button>
            {need ? <span id={hintId} className="text-small text-muted-foreground">{need}</span> : null}
          </span>
          <Button variant="outline" disabled={!canManage || toggle.isPending} onClick={() => (row.active ? setConfirmOff(true) : toggle.mutate())}>{row.active ? tc('deactivate') : tc('activate')}</Button>
        </div>
        {toggle.error ? (
          <Alert variant="destructive" role="alert">
            <AlertTitle>{toggle.error instanceof ApiError ? toggle.error.problem.title : tc('formError')}</AlertTitle>
            {toggle.error instanceof ApiError && toggle.error.problem.detail ? <AlertDescription className="text-foreground!">{toggle.error.problem.detail}</AlertDescription> : null}
          </Alert>
        ) : null}
      </header>

      <Tabs defaultValue="info">
        <TabsList className="h-auto flex-wrap group-data-horizontal/tabs:h-auto">
          {(['info', 'docs', 'open'] as const).map((k) => <TabsTrigger key={k} value={k} className="h-8 flex-auto">{tr(`tabs.${k}`)}</TabsTrigger>)}
        </TabsList>
        <TabsContent value="info"><Details d={d} row={row} /></TabsContent>
        <TabsContent value="docs"><PartyDocs d={d} row={row} companyId={companyId} /></TabsContent>
        <TabsContent value="open"><OpenItems d={d} row={row} companyId={companyId} /></TabsContent>
      </Tabs>

      {confirmOff ? (
        <AlertDialog open onOpenChange={(o) => { if (!o) setConfirmOff(false); }}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{tc('deactivateTitle', { name: String(row.name ?? row.code) })}</AlertDialogTitle>
              <AlertDialogDescription>{tc('deactivateBody')}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{tc('cancel')}</AlertDialogCancel>
              <AlertDialogAction onClick={() => toggle.mutate()}>{tc('deactivate')}</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
      {editing ? <RecordFormDialog descriptor={d} row={row} onSaved={() => setEditing(false)} onClose={() => setEditing(false)} /> : null}
    </div>
  );
}

function Details({ d, row }: { d: RecordDescriptor; row: RecordRow }) {
  const t = useTranslations();
  const tc = useTranslations('records.common');
  const show = (f: FieldSpec): ReactNode => {
    const v = row[f.key];
    if (f.kind === 'bool') return v ? tc('yes') : tc('no');
    if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) return <span className="text-muted-foreground">{tc('none')}</span>;
    if (f.kind === 'select') return f.options?.find((o) => o.value === v) ? t(f.options.find((o) => o.value === v)!.labelKey) : String(v);
    if (f.kind === 'date') return formatDateBE(String(v));
    return Array.isArray(v) ? v.join(', ') : String(v);
  };
  return (
    <dl className="grid grid-cols-[repeat(auto-fit,minmax(14rem,1fr))] gap-x-6 gap-y-3 rounded-lg border bg-card p-4 text-body">
      {d.fields.filter((f) => isVisible(f, row)).map((f) => (
        <div key={f.key} className={cn(f.kind === 'textarea' && 'sm:col-span-2')}>
          <dt className="text-small text-muted-foreground">{t(f.labelKey)}</dt>
          <dd className="whitespace-pre-line">{show(f)}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Shared by the two list tabs: pending / error / forbidden are never shown as an empty list. */
function Query({ q, children, forbiddenPermission }: { q: { isPending: boolean; error: unknown; refetch: () => unknown }; children: ReactNode; forbiddenPermission?: string }) {
  if (q.isPending) return <LoadingState rows={3} />;
  if (q.error) {
    return isForbidden(q.error)
      ? <ForbiddenState permission={forbiddenPermission} detail={q.error instanceof ApiError ? q.error.problem.detail : undefined} />
      : <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  }
  return <>{children}</>;
}

function PartyDocs({ row, companyId }: { d: RecordDescriptor; row: RecordRow; companyId: string }) {
  const t = useTranslations();
  const tr = useTranslations('records.view');
  const q = useQuery({ queryKey: qk.docsByParty(companyId, row.id), queryFn: () => endpoints.docsByParty(row.id) });
  return (
    <Query q={q}>
      {q.data && q.data.items.length === 0 ? <EmptyState title={tr('docsEmpty')} /> : (
        <div className="overflow-x-auto rounded-lg border bg-card">
          <Table>
            <TableHeader><TableRow>
              <TableHead>{tr('number')}</TableHead><TableHead>{tr('type')}</TableHead><TableHead>{tr('date')}</TableHead>
              <TableHead>{tr('status')}</TableHead><TableHead className="text-right">{tr('total')}</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {q.data?.items.map((i) => {
                const href = docViewHref(i.type, i.id);
                const label = i.number ?? t('common.draftNoNumber');
                return (
                  <TableRow key={i.id}>
                    <TableCell className="tabular-nums">{href ? <Link href={href} className="text-primary hover:underline">{label}</Link> : label}</TableCell>
                    <TableCell>{i.type}</TableCell>
                    <TableCell className="tabular-nums">{formatDateBE(i.documentDate)}</TableCell>
                    <TableCell><StatusChip status={i.status as DocStatus} /></TableCell>
                    <TableCell className="text-right tabular-nums">{formatTHB(i.total)}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </Query>
  );
}

function OpenItems({ d, row, companyId }: { d: RecordDescriptor; row: RecordRow; companyId: string }) {
  const tr = useTranslations('records.view');
  const types = (d.kind === 'vendor' ? SETTLES.PV : SETTLES.RC) ?? [];
  const q = useQuery({ queryKey: qk.openItems(companyId, row.id, types.join(',')), queryFn: () => endpoints.openItems({ partyId: row.id, types }) });
  return (
    <Query q={q} forbiddenPermission={types.map((x) => `doc.${x}.read`)[0]}>
      {q.data && q.data.items.length === 0 ? <EmptyState title={tr('openEmpty')} /> : (
        <div className="overflow-x-auto rounded-lg border bg-card">
          <Table>
            <TableHeader><TableRow>
              <TableHead>{tr('number')}</TableHead><TableHead>{tr('type')}</TableHead><TableHead>{tr('date')}</TableHead><TableHead>{tr('due')}</TableHead>
              <TableHead className="text-right">{tr('total')}</TableHead><TableHead className="text-right">{tr('outstanding')}</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {q.data?.items.map((i) => (
                <TableRow key={i.id}>
                  <TableCell className="tabular-nums">{docViewHref(i.type, i.id) ? <Link href={docViewHref(i.type, i.id)!} className="text-primary hover:underline">{i.number}</Link> : i.number}</TableCell>
                  <TableCell>{i.type}</TableCell>
                  <TableCell className="tabular-nums">{formatDateBE(i.documentDate)}</TableCell>
                  <TableCell className="tabular-nums">{i.dueDate ? formatDateBE(i.dueDate) : '–'}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(i.total)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(i.outstanding)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <p className="flex justify-between gap-4 border-t p-3 font-semibold" role="status">
            <span>{tr('openTotal')}</span><span className="tabular-nums">{q.data ? formatTHB(q.data.total) : ''}</span>
          </p>
        </div>
      )}
    </Query>
  );
}
