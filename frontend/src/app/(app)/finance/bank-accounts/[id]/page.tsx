'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { useCompanyEpoch } from '@/app-shell/useCompanyEpoch';
import { isForbidden, useMe } from '@/app-shell/useMe';
import type { RecordRow } from '@/domain/records';
import { ApiError } from '@/lib/api/client';
import { endpoints } from '@/lib/api/endpoints';
import { qk } from '@/lib/query/keys';
import { ImportDialog } from '@/kit/bank/ImportDialog';
import { ReconcileTab } from '@/kit/bank/ReconcileTab';
import { StatementLines } from '@/kit/bank/StatementLines';
import { RecordFormDialog } from '@/kit/record-form/RecordForm';
import { ErrorState } from '@/kit/states/ErrorState';
import { ForbiddenState } from '@/kit/states/ForbiddenState';
import { LoadingState } from '@/kit/states/LoadingState';
import { NotFoundState } from '@/kit/states/NotFoundState';
import { bankAccount as descriptor } from '@/records/bank-accounts';

/** FN1: one bank / cash account (the custom detail page of the `bank-account` record): its facts, edit / close, and the imported statement lines. */
export default function BankAccountPage() {
  return <BankAccountInner key={useCompanyEpoch()} />;
}

function BankAccountInner() {
  const { id } = useParams<{ id: string }>();
  const tr = useTranslations('records.view');
  const { me, isPending: mePending, error: meError, refetch: refetchMe } = useMe();
  const q = useQuery({ queryKey: qk.record(me?.activeCompanyId ?? '', descriptor.kind, id), queryFn: () => endpoints.getRecord(descriptor.kind, id), enabled: !!me });
  if (meError) return <ErrorState error={meError} onRetry={() => void refetchMe()} />;
  if (mePending || q.isPending) return <LoadingState />;
  if (q.error) {
    if (q.error instanceof ApiError && q.error.code === 'record.not_found') return <NotFoundState listHref={descriptor.basePath} title={tr('notFoundTitle')} body={tr('notFoundBody')} />;
    return isForbidden(q.error)
      ? <ForbiddenState permission={descriptor.permissions.read} detail={q.error instanceof ApiError ? q.error.problem.detail : undefined} />
      : <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  }
  return <Loaded row={q.data} permissions={me!.permissions} companyId={me!.activeCompanyId} />;
}

function Loaded({ row, permissions, companyId }: { row: RecordRow; permissions: string[]; companyId: string }) {
  const t = useTranslations();
  const tb = useTranslations('bank');
  const tc = useTranslations('records.common');
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [confirmOff, setConfirmOff] = useState(false);
  const [importing, setImporting] = useState(false);
  const hintId = useId();
  const router = useRouter();
  const search = useSearchParams();
  const focusLine = search.get('line') ?? undefined; // the exit of a matched document's lock lands on its line
  const tab = focusLine || search.get('tab') === 'reconcile' ? 'reconcile' : 'lines';
  const go = (next: Record<string, string | undefined>) => { const u = new URLSearchParams(search.toString()); for (const [k, v] of Object.entries(next)) { if (v) u.set(k, v); else u.delete(k); } router.replace(`?${u}`); };
  const canManage = permissions.includes(descriptor.permissions.manage);
  const isBank = row.kind === 'bank';
  const toggle = useMutation({
    mutationFn: () => endpoints.setRecordActive(descriptor.kind, row.id, !row.active, row.version),
    onSuccess: () => qc.invalidateQueries({ queryKey: [companyId] }),
    onError: (e) => { if (e instanceof ApiError && e.code === 'record.version_conflict') void qc.invalidateQueries({ queryKey: [companyId] }); },
  });
  const need = canManage ? undefined : tc('needManage', { permission: descriptor.permissions.manage });
  const facts: [string, string][] = [
    [tb('kind'), t(`records.options.bankKind.${String(row.kind)}`)],
    ...(isBank ? [[tb('bankName'), t(`records.options.bankName.${String(row.bankName)}`)], [tb('accountNo'), String(row.accountNo ?? '')]] as [string, string][] : []),
    [tb('gl'), String(row.accountCode)],
  ];

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
      <header className="grid gap-2">
        <p className="text-small text-muted-foreground"><Link href={descriptor.basePath} className="hover:underline">{t(descriptor.titleKey)}</Link></p>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-h1 font-semibold">{String(row.accountName)}</h1>
          <Badge variant={row.active ? 'secondary' : 'outline'}>{row.active ? tc('activeTrue') : tc('activeFalse')}</Badge>
        </div>
        <dl className="grid grid-cols-[repeat(auto-fit,minmax(10rem,1fr))] gap-x-6 gap-y-2 text-body">
          {facts.map(([k, v]) => <div key={k}><dt className="text-small text-muted-foreground">{k}</dt><dd className="tabular-nums">{v}</dd></div>)}
        </dl>
        <div className="flex flex-wrap items-start gap-2">
          <span className="inline-flex flex-col items-start gap-1">
            <Button disabled={!canManage} aria-describedby={need ? hintId : undefined} onClick={() => setEditing(true)}>{tc('edit')}</Button>
            {need ? <span id={hintId} className="text-small text-muted-foreground">{need}</span> : null}
          </span>
          <Button variant="outline" disabled={!canManage || toggle.isPending} onClick={() => (row.active ? setConfirmOff(true) : toggle.mutate())}>{row.active ? tc('deactivate') : tc('activate')}</Button>
          {isBank ? <Button variant="outline" disabled={!canManage} onClick={() => setImporting(true)}>{tb('import.open')}</Button> : null}
        </div>
        {toggle.error ? (
          <Alert variant="destructive" role="alert">
            <AlertTitle>{toggle.error instanceof ApiError ? toggle.error.problem.title : tc('formError')}</AlertTitle>
            {toggle.error instanceof ApiError && toggle.error.problem.detail ? <AlertDescription className="text-foreground!">{toggle.error.problem.detail}</AlertDescription> : null}
          </Alert>
        ) : null}
      </header>

      {isBank ? (
        <Tabs value={tab} onValueChange={(v) => go({ tab: v === 'reconcile' ? 'reconcile' : undefined, line: undefined })}>
          <TabsList aria-label={tb('tabs.label')}>
            <TabsTrigger value="lines">{tb('tabs.lines')}</TabsTrigger>
            <TabsTrigger value="reconcile">{tb('tabs.reconcile')}</TabsTrigger>
          </TabsList>
          <TabsContent value="lines"><StatementLines accountId={row.id} onImport={canManage ? () => setImporting(true) : undefined} /></TabsContent>
          <TabsContent value="reconcile">
            <ReconcileTab accountId={row.id} accountCode={String(row.accountCode)} permissions={permissions} focusLine={focusLine} onShowAll={() => go({ line: undefined })} />
          </TabsContent>
        </Tabs>
      ) : <p className="text-muted-foreground">{tb('noStatements')}</p>}

      {confirmOff ? (
        <AlertDialog open onOpenChange={(o) => { if (!o) setConfirmOff(false); }}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{tc('deactivateTitle', { name: String(row.accountName) })}</AlertDialogTitle>
              <AlertDialogDescription>{tc('deactivateBody')}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{tc('cancel')}</AlertDialogCancel>
              <AlertDialogAction onClick={() => toggle.mutate()}>{tc('deactivate')}</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
      {editing ? <RecordFormDialog descriptor={descriptor} row={row} onSaved={() => setEditing(false)} onClose={() => setEditing(false)} /> : null}
      {importing ? <ImportDialog accountId={row.id} onClose={() => setImporting(false)} /> : null}
    </div>
  );
}
