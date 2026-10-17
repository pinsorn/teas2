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
import { FilingBoxes } from './FilingBoxes';
import { FilingHistory } from './FilingHistory';
import { FinalizeDialog } from './FinalizeDialog';

/** A filing for one period (`?period=`, default = the month after the last one finalized): boxes (each linking to its register), tie-outs, blockers, finalize (ConfirmIssue anatomy), the RD Prep text and the history. A finalized period is read-only
 *  and shows the snapshot. Requires tax.read to view, tax.filing.preview to compute, tax.filing.finalize to finalize. Remounts on a company switch. */
export function FilingView(p: { form: FilingForm; periodKind: 'month' | 'year' }) {
  return <Inner key={useCompanyEpoch()} {...p} />;
}

function Inner({ form }: { form: FilingForm; periodKind: 'month' | 'year' }) {
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
  const hist = useQuery({ queryKey: qk.filings(companyId, form), queryFn: () => endpoints.listFilings(form), enabled: !!companyId && !!me?.vatRegistered });
  const period = search.get('period') || hist.data?.next || '';
  const q = useQuery({ queryKey: qk.filing(companyId, form, period), queryFn: () => endpoints.getFiling(form, period), enabled: !!companyId && !!me?.vatRegistered && !!period });
  const [confirming, setConfirming] = useState(false);
  const finalize = useMutation({
    mutationFn: () => endpoints.finalizeFiling(form, period, q.data!.version),
    onSuccess: async () => { setConfirming(false); await qc.invalidateQueries({ queryKey: [companyId, 'filings'] }); await qc.invalidateQueries({ queryKey: [companyId, 'doc'] }); },
  });
  const pick = (value: string) => { const u = new URLSearchParams(search.toString()); if (value) u.set('period', value); else u.delete('period'); router.replace(`${pathname}?${u}`); };

  if (meFailed && !me) return <ErrorState error={meError} onRetry={() => void refetchMe()} />;
  if (!me) return <LoadingState />;
  if (!me.vatRegistered) return <NotAvailableState reason="vatOnly" />;
  const failed = (hist.isError && !hist.data ? hist.error : undefined) ?? (q.isError && !q.data ? q.error : undefined);
  if (failed) return isForbidden(failed) ? <ForbiddenState detail={failed instanceof ApiError ? failed.problem.detail : undefined} permission="tax.read" /> : <ErrorState error={failed} onRetry={() => { void hist.refetch(); void q.refetch(); }} />;
  if (!q.data || !hist.data) return <LoadingState />;

  const m = q.data, filed = m.status === 'finalized', first = m.blockers[0];
  const canFinalize = me.permissions.includes('tax.filing.finalize');
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
          <Label htmlFor="filing-period">{t('period')}</Label>
          <Input id="filing-period" type="month" value={period} onChange={(e) => pick(e.target.value)} className="w-44" />
        </div>
        <p className="text-body text-muted-foreground">{t('due', { date: formatDateBE(m.dueDate) })}</p>
      </div>
      <h2 className="text-section font-semibold">{t('title', { month: monthBE(period) })}</h2>
      {filed ? (
        <Alert role="status" data-testid="filed-banner">
          <LockIcon aria-hidden />
          <AlertTitle>{t('filed.title')}</AlertTitle>
          <AlertDescription>{t('filed.body', { by: m.finalizedBy ?? '', at: formatDateBE((m.finalizedAt ?? '').slice(0, 10)) })}</AlertDescription>
        </Alert>
      ) : null}
      <TieOutBanner tieOuts={m.tieOuts} />
      {m.boxes.length === 0 ? <EmptyState title={t('empty.title')} body={t('empty.body')} /> : <FilingBoxes boxes={m.boxes} period={period} />}
      {m.tieOuts.filter((o) => o.diff === '0.00').map((o) => (
        <p key={o.labelKey} className="text-small text-muted-foreground tabular-nums">{tr('tieOut.ok')}: {dyn(o.labelKey, { left: formatMoney(o.left), right: formatMoney(o.right) })}</p>
      ))}
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
          <Button variant="outline" onClick={() => void exportTxt()}><DownloadIcon aria-hidden />{t('export.txt')}</Button>
        )}
        <Button variant="outline" onClick={() => window.print()}><PrinterIcon aria-hidden />{t('export.print')}</Button>
      </div>
      <FinalizeDialog open={confirming} month={monthBE(period)} boxes={m.boxes} pending={finalize.isPending} error={finalize.error} onConfirm={() => finalize.mutate()} onCancel={() => setConfirming(false)} />
      <FilingHistory items={hist.data.items} />
    </div>
  );
}
