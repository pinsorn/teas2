'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DownloadIcon, LockIcon, PrinterIcon, TriangleAlertIcon } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { toast } from 'sonner';
import { useCompanyEpoch } from '@/app-shell/useCompanyEpoch';
import { isForbidden, useMe } from '@/app-shell/useMe';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { FilingForm } from '@/domain/filings';
import { ApiError } from '@/lib/api/client';
import { endpoints } from '@/lib/api/endpoints';
import { formatDateBE, formatMoney } from '@/lib/format';
import { qk } from '@/lib/query/keys';
import { monthBE } from '../close/PeriodGrid';
import { EmptyState } from '../states/EmptyState';
import { ErrorState } from '../states/ErrorState';
import { ForbiddenState } from '../states/ForbiddenState';
import { LoadingState } from '../states/LoadingState';
import { NotAvailableState } from '../states/NotAvailableState';
import { TieOutBanner } from '../report/TieOutBanner';
import { FilingAttachment, FilingBoxes } from './FilingBoxes';
import { FilingHistory } from './FilingHistory';
import { FinalizeDialog } from './FinalizeDialog';
import { TaxPaymentDialog } from './TaxPaymentDialog';

/** A filing for one period (`?period=`, default = the month after the last one finalized): boxes (each linking to its register), tie-outs, blockers, finalize (ConfirmIssue anatomy), the RD Prep text and the history. A finalized period is read-only
 *  and shows the snapshot. Requires tax.read to view, tax.filing.preview to compute, tax.filing.finalize to finalize. Remounts on a company switch. */
export function FilingView(p: { form: FilingForm; periodKind: 'month' | 'year' }) {
  return <Inner key={useCompanyEpoch()} {...p} />;
}

function Inner({ form, periodKind }: { form: FilingForm; periodKind: 'month' | 'year' }) {
  const t = useTranslations('filing');
  const tr = useTranslations('reports');
  const tx = useTranslations();
  const dyn = tx as unknown as (key: string, v: Record<string, string>) => string; // server-supplied label keys are not statically known
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const qc = useQueryClient();
  const { me, isError: meFailed, error: meError, refetch: refetchMe } = useMe();
  const companyId = me?.activeCompanyId ?? '';
  // only the ภ.พ.30 is VAT-only: the withholding returns and the ภ.พ.36 belong to every company
  const applies = !!me && (form !== 'PP30' || me.vatRegistered);
  const hist = useQuery({ queryKey: qk.filings(companyId, form), queryFn: () => endpoints.listFilings(form), enabled: !!companyId && applies });
  const period = search.get('period') || hist.data?.next || '';
  const q = useQuery({ queryKey: qk.filing(companyId, form, period), queryFn: () => endpoints.getFiling(form, period), enabled: !!companyId && applies && !!period });
  const year = periodKind === 'year'; // TX3a: ภ.ง.ด.50 / 51 name a fiscal year (YYYY, Christian era in the URL)
  const periodLabel = year ? t('yearLabel', { year: String(Number(period) + 543) }) : monthBE(period);
  const [confirming, setConfirming] = useState(false);
  const finalize = useMutation({
    mutationFn: (ack: boolean) => endpoints.finalizeFiling(form, period, q.data!.version, ack),
    onSuccess: async () => { setConfirming(false); await qc.invalidateQueries({ queryKey: [companyId, 'filings'] }); await qc.invalidateQueries({ queryKey: [companyId, 'doc'] }); },
  });
  const [paying, setPaying] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const [reason, setReason] = useState('');
  const undo = useMutation({
    mutationFn: (journalId: string) => endpoints.reverseTaxPayment(journalId, reason.trim()),
    onSuccess: async () => { setUndoing(false); setReason(''); await qc.invalidateQueries({ queryKey: [companyId] }); },
  });
  const pick = (value: string) => { const u = new URLSearchParams(search.toString()); if (value) u.set('period', value); else u.delete('period'); router.replace(`${pathname}?${u}`); };

  if (meFailed && !me) return <ErrorState error={meError} onRetry={() => void refetchMe()} />;
  if (!me) return <LoadingState />;
  if (!applies) return <NotAvailableState reason="vatOnly" />;
  const failed = (hist.isError && !hist.data ? hist.error : undefined) ?? (q.isError && !q.data ? q.error : undefined);
  if (failed) return isForbidden(failed) ? <ForbiddenState detail={failed instanceof ApiError ? failed.problem.detail : undefined} permission="tax.read" /> : <ErrorState error={failed} onRetry={() => { void hist.refetch(); void q.refetch(); }} />;
  if (!q.data || !hist.data) return <LoadingState />;

  const m = q.data, filed = m.status === 'finalized', first = m.blockers[0];
  const canFinalize = me.permissions.includes('tax.filing.finalize');
  const canPay = me.permissions.includes('bank.reconcile');
  const exportTxt = async () => {
    try {
      const url = URL.createObjectURL(new Blob([await endpoints.exportFiling(form, period, 'rdprep-txt')], { type: 'text/plain;charset=utf-8' }));
      const a = document.createElement('a');
      a.href = url; a.download = `${form}-${period}.txt`;
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch { toast.error(t('export.failed')); }
  };
  const disabledWhy = !canFinalize ? t('finalize.needPermission') : first ? t('finalize.disabledBy', { why: first.labelTh }) : undefined;
  return (
    <div className="grid gap-4" data-testid="filing-view">
      <div className="flex flex-wrap items-end gap-4 print:hidden">
        <div className="grid gap-1.5">
          <Label htmlFor="filing-period">{year ? t('periodYear') : t('period')}</Label>
          <Input id="filing-period" type={year ? 'number' : 'month'} {...(year ? { min: 2000, max: 2100, step: 1 } : {})} value={period} onChange={(e) => pick(e.target.value)} className="w-44" />
        </div>
        <p className="text-body text-muted-foreground">{t('due', { date: formatDateBE(m.dueDate) })}</p>
      </div>
      <h2 className="text-section font-semibold">{year ? t('titleYear', { form: t(`forms.${form}`), year: String(Number(period) + 543) }) : t('title', { form: t(`forms.${form}`), month: monthBE(period) })}</h2>
      {filed ? (
        <Alert role="status" data-testid="filed-banner">
          <LockIcon aria-hidden />
          <AlertTitle>{t('filed.title')}</AlertTitle>
          <AlertDescription>{t(form === 'PP30' ? 'filed.body' : year ? 'filed.bodyCit' : 'filed.bodyOther', { by: m.finalizedBy ?? '', at: formatDateBE((m.finalizedAt ?? '').slice(0, 10)) })}</AlertDescription>
        </Alert>
      ) : null}
      {filed && m.payment ? (
        <section aria-label={t('payment.title')} className="grid gap-2 rounded-lg border bg-card p-4 print:hidden" data-testid="tax-payment">
          <h3 className="font-semibold">{t('payment.title')}</h3>
          {m.payment.status === 'nothing_due' ? <p className="text-muted-foreground">{t('payment.nothingDue')}</p> : null}
          {m.payment.status === 'unpaid' ? (
            <div className="flex flex-wrap items-center gap-3">
              <p className="tabular-nums">{t('payment.due', { amount: formatMoney(m.payment.due) })}</p>
              {canPay ? <Button onClick={() => setPaying(true)}>{t('payment.pay')}</Button> : <span className="text-small text-muted-foreground">{t('payment.needPermission')}</span>}
            </div>
          ) : null}
          {m.payment.status === 'paid' ? (
            <>
              <Alert role="status">
                <AlertTitle>{t('payment.paid', { date: formatDateBE(m.payment.paidOn ?? '') })}</AlertTitle>
                {m.payment.extras ? <AlertDescription>{t('payment.extras', { amount: formatMoney(m.payment.extras) })}</AlertDescription> : null}
              </Alert>
              <div className="flex flex-wrap items-center gap-3">
                {m.payment.accountId && m.payment.lineId ? <Link href={`/finance/bank-accounts/${m.payment.accountId}?line=${m.payment.lineId}`} className="text-primary underline underline-offset-2">{t('payment.openLine')}</Link> : null}
                {canPay ? <Button variant="outline" onClick={() => { undo.reset(); setReason(''); setUndoing(true); }}>{t('payment.reverse')}</Button> : null}
              </div>
            </>
          ) : null}
        </section>
      ) : null}
      <TieOutBanner tieOuts={m.tieOuts} />
      {m.boxes.length === 0 ? <EmptyState title={t('empty.title')} body={t('empty.body')} /> : <FilingBoxes boxes={m.boxes} period={period} />}
      {m.tieOuts.filter((o) => o.diff === '0.00').map((o) => (
        <p key={o.labelKey} className="text-small text-muted-foreground tabular-nums">{tr('tieOut.ok')}: {dyn(o.labelKey, { left: formatMoney(o.left), right: formatMoney(o.right) })}
          {o.reconciling?.map((r) => <span key={r.labelTh} data-testid="reconciling"> ({t('tie.reconciling')}: {r.labelTh} {formatMoney(r.amount)})</span>)}</p>
      ))}
      {m.attachment ? <FilingAttachment attachment={m.attachment} /> : null}
      {m.warnings.map((w) => <p key={w} className="flex items-start gap-2 text-small text-muted-foreground"><TriangleAlertIcon aria-hidden className="mt-0.5 size-4 shrink-0" />{w}</p>)}
      {!filed && m.blockers.length ? (
        <section aria-label={t('blockers.title')} className="grid gap-2 rounded-lg border bg-card p-4" data-testid="blockers">
          <h3 className="font-semibold">{t('blockers.title')}</h3>
          <ul className="grid gap-1">
            {m.blockers.map((b, i) => (
              <li key={`${b.code}-${i}`} className="flex flex-wrap items-center gap-2" data-testid={`blocker-${b.code}`}>
                <span>{b.labelTh}</span>
                {b.href ? <Link href={b.href} className="text-primary underline underline-offset-2">{t('blockers.open')}</Link> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <div className="flex flex-wrap items-center gap-2 print:hidden">
        {!filed ? (
          <>
            <Button disabled={!!disabledWhy || m.boxes.length === 0} onClick={() => { finalize.reset(); setConfirming(true); }}>{t('finalize.button')}</Button>
            {disabledWhy ? <span className="text-small text-muted-foreground" data-testid="finalize-why">{disabledWhy}</span> : null}
          </>
        ) : (
          m.exports.includes('rdprep-txt') ? <Button variant="outline" onClick={() => void exportTxt()}><DownloadIcon aria-hidden />{t('export.txt')}</Button> : null
        )}
        <Button variant="outline" onClick={() => window.print()}><PrinterIcon aria-hidden />{t('export.print')}</Button>
      </div>
      <FinalizeDialog open={confirming} form={form} month={periodLabel} boxes={m.boxes} pending={finalize.isPending} error={finalize.error} onConfirm={(ack) => finalize.mutate(ack)} onCancel={() => setConfirming(false)} />
      {paying ? <TaxPaymentDialog form={form} period={period} onClose={() => setPaying(false)} /> : null}
      {undoing && m.payment?.journalId ? (
        <AlertDialog open onOpenChange={(o) => { if (!o) setUndoing(false); }}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t('payment.reverse')}</AlertDialogTitle>
              <AlertDialogDescription>{t('payment.reverseDesc')}</AlertDialogDescription>
            </AlertDialogHeader>
            <div className="grid gap-1.5">
              <Label htmlFor="payment-reason">{t('payment.reason')} <span aria-hidden>*</span></Label>
              <Input id="payment-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
            </div>
            {undo.error ? <p role="alert" className="text-destructive">{undo.error instanceof ApiError ? undo.error.problem.title : t('payment.failed')}</p> : null}
            <AlertDialogFooter>
              <AlertDialogCancel>{t('payment.back')}</AlertDialogCancel>
              <AlertDialogAction disabled={!reason.trim() || undo.isPending} onClick={(e) => { e.preventDefault(); undo.mutate(m.payment!.journalId!); }}>{undo.isPending ? t('payment.working') : t('payment.reverse')}</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
      <FilingHistory items={hist.data.items} />
    </div>
  );
}
