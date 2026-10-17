'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { monthBE } from '../close/PeriodGrid';
import { useId, useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { isForbidden, useMe } from '@/app-shell/useMe';
import type { ReportParamSpec } from '@/domain/reports';
import type { BankLine } from '@/domain/types';
import { ApiError } from '@/lib/api/client';
import { endpoints } from '@/lib/api/endpoints';
import { formatDateBE } from '@/lib/format';
import { qk } from '@/lib/query/keys';
import { ReportView } from '../report/ReportView';
import { ErrorState } from '../states/ErrorState';
import { ForbiddenState } from '../states/ForbiddenState';
import { LoadingState } from '../states/LoadingState';
import { InlineJournalDialog } from './InlineJournalDialog';
import { MatchPanel } from './MatchPanel';
import { StatementLines } from './StatementLines';
import { TransferDialog } from './TransferDialog';

const PARAMS: ReportParamSpec[] = [
  { key: 'account', kind: 'account', labelKey: 'bank.reconcile.report.account', required: true, hidden: true },
  { key: 'to', kind: 'date', labelKey: 'reports.asOf', required: true },
];
const problemOf = (e: unknown, fallback: string) => (e instanceof ApiError ? e.problem : { title: fallback, detail: undefined });

/** FN2 workspace of one bank account (tab "กระทบยอด"): the statement lines with their actions (find a match, book to an account, skip, unmatch), the lock-to-date control, and the reconciliation report.
 *  Needs `bank.reconcile`; without it the tab says so. A line asked for by `?line=` (the lock exit of a matched document) is shown alone. */
export function ReconcileTab({ accountId, accountCode, permissions, focusLine, onShowAll }: {
  accountId: string; accountCode: string; permissions: string[]; focusLine?: string; onShowAll: () => void;
}) {
  const t = useTranslations('bank.reconcile');
  const tf = useTranslations('filing');
  const qc = useQueryClient();
  const { me } = useMe();
  const id = useId();
  const company = me?.activeCompanyId ?? '';
  const allowed = permissions.includes('bank.reconcile');
  const [matching, setMatching] = useState<BankLine>();
  const [posting, setPosting] = useState<BankLine>();
  const [transferring, setTransferring] = useState<BankLine>();
  const [asking, setAsking] = useState<{ line: BankLine; command: 'unmatch' | 'unignore' | 'reverse' }>();
  const [reason, setReason] = useState('');
  const [lockDate, setLockDate] = useState('');
  const rec = useQuery({ queryKey: qk.bankReconciliation(company, accountId), queryFn: () => endpoints.getReconciliation(accountId), enabled: !!me && allowed });

  const refresh = () => qc.invalidateQueries({ queryKey: [company] });
  const command = useMutation({
    mutationFn: (v: { line: BankLine; command: 'unmatch' | 'ignore' | 'unignore' | 'reverse'; reason?: string }) => (v.command === 'reverse'
      ? endpoints.reverseBankTransfer((v.line.transfer?.journalId ?? v.line.transferPending)!, v.reason ?? '').then(() => undefined)
      : endpoints.bankLineCommand(v.line.id, v.command, v.reason).then(() => undefined)),
    onSuccess: async () => { await refresh(); setAsking(undefined); setReason(''); },
  });
  const lock = useMutation({
    mutationFn: () => endpoints.lockReconciliation(accountId, lockDate),
    onSuccess: async () => { await refresh(); setLockDate(''); },
  });

  if (!allowed) return <ForbiddenState permission="bank.reconcile" />;
  if (rec.isError && !rec.data) return isForbidden(rec.error) ? <ForbiddenState permission="bank.reconcile" /> : <ErrorState error={rec.error} onRetry={() => void rec.refetch()} />;
  if (!rec.data || !me) return <LoadingState />;

  const err = command.error ?? lock.error;
  const actions = (l: BankLine) => {
    const b = (label: string, fn: () => void, variant: 'default' | 'outline' = 'outline') => <Button key={label} size="sm" variant={variant} disabled={command.isPending} onClick={fn}>{label}</Button>;
    if (l.status === 'unmatched') return [b(t('find'), () => setMatching(l), 'default'), b(t('post.open'), () => setPosting(l)), b(t('transfer.open'), () => setTransferring(l)), b(t('ignore'), () => command.mutate({ line: l, command: 'ignore' })),
      ...(l.transferPending ? [b(t('transfer.reverse'), () => { setReason(''); setAsking({ line: l, command: 'reverse' }); })] : [])];
    if (l.status === 'matched') return [b(t('unmatch'), () => { setReason(''); setAsking({ line: l, command: 'unmatch' }); }), ...(l.transfer ? [b(t('transfer.reverse'), () => { setReason(''); setAsking({ line: l, command: 'reverse' }); })] : [])];
    if (l.status === 'ignored') return [b(t('unignore'), () => { setReason(''); setAsking({ line: l, command: 'unignore' }); })];
    if (l.taxPayment) return [<Link key="tax" href={l.taxPayment.href} className="text-small text-primary underline underline-offset-2">{t('taxPaid', { form: tf(`forms.${l.taxPayment.form}`), month: monthBE(l.taxPayment.period) })}</Link>];
    return [<span key="p" className="text-small text-muted-foreground">{t('postedFinal')}</span>];
  };
  const need = (asking?.line.locked || asking?.command === 'reverse') && !reason.trim();

  return (
    <div className="grid gap-6">
      <section aria-labelledby={`${id}-lock`} className="grid gap-2">
        <h2 id={`${id}-lock`} className="text-section font-semibold">{t('lock.title')}</h2>
        <p className="text-body">
          {rec.data.reconciledTo ? t('lock.current', { date: formatDateBE(rec.data.reconciledTo) }) : t('lock.none')}
          {' · '}{t('lock.counts', { unmatched: rec.data.counts.unmatched, matched: rec.data.counts.matched, ignored: rec.data.counts.ignored, posted: rec.data.counts.posted })}
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-date`}>{t('lock.date')}</Label>
            <Input id={`${id}-date`} type="date" value={lockDate} min={rec.data.reconciledTo ?? undefined} onChange={(e) => setLockDate(e.target.value)} className="w-auto" />
          </div>
          <Button variant="outline" disabled={!lockDate || lock.isPending} onClick={() => lock.mutate()}>{t('lock.submit')}</Button>
        </div>
        <p className="text-small text-muted-foreground">{t('lock.hint')}</p>
      </section>

      {err ? (
        <Alert variant="destructive" role="alert">
          <AlertTitle>{problemOf(err, t('failed')).title}</AlertTitle>
          {problemOf(err, '').detail ? <AlertDescription className="text-foreground!">{problemOf(err, '').detail}</AlertDescription> : null}
        </Alert>
      ) : null}

      <StatementLines accountId={accountId} actions={actions} only={focusLine} onShowAll={onShowAll} />

      <section aria-labelledby={`${id}-report`} className="grid gap-2">
        <h2 id={`${id}-report`} className="text-section font-semibold">{t('report.title')}</h2>
        <ReportView kind="bank-reconciliation" params={PARAMS} defaults={{ account: accountId, to: me.businessDate }} />
      </section>

      {matching ? <MatchPanel line={matching} onClose={() => setMatching(undefined)} /> : null}
      {posting ? <InlineJournalDialog line={posting} bankAccountCode={accountCode} onClose={() => setPosting(undefined)} /> : null}
      {transferring ? <TransferDialog line={transferring} accountId={accountId} onClose={() => setTransferring(undefined)} /> : null}
      {asking ? (
        <AlertDialog open onOpenChange={(o) => { if (!o) { setAsking(undefined); command.reset(); } }}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{asking.command === 'reverse' ? t('transfer.reverse') : t(`${asking.command}Title`)}</AlertDialogTitle>
              <AlertDialogDescription>{asking.command === 'reverse' ? t('transfer.reverseDesc') : asking.line.locked ? t('lockedReason') : t('reasonOptional')}</AlertDialogDescription>
            </AlertDialogHeader>
            <div className="grid gap-1.5">
              <Label htmlFor={`${id}-reason`}>{t('reason')}{asking.line.locked || asking.command === 'reverse' ? <span aria-hidden> *</span> : null}</Label>
              <Input id={`${id}-reason`} value={reason} onChange={(e) => setReason(e.target.value)} />
            </div>
            {command.error ? <p role="alert" className="text-destructive">{problemOf(command.error, t('failed')).title}</p> : null}
            <AlertDialogFooter>
              <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
              <AlertDialogAction disabled={need || command.isPending} onClick={(e) => { e.preventDefault(); command.mutate({ line: asking.line, command: asking.command, reason: reason.trim() || undefined }); }}>{asking.command === 'reverse' ? t('transfer.reverse') : t(asking.command)}</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
    </div>
  );
}
