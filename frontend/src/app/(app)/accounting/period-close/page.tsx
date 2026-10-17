'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Alert, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useCompanyEpoch } from '@/app-shell/useCompanyEpoch';
import { isForbidden, useMe } from '@/app-shell/useMe';
import type { PeriodsView } from '@/domain/types';
import { ApiError } from '@/lib/api/client';
import { endpoints } from '@/lib/api/endpoints';
import { formatDateBE, formatMoney } from '@/lib/format';
import { ChecklistPanel } from '@/kit/close/ChecklistPanel';
import { PeriodGrid, monthBE } from '@/kit/close/PeriodGrid';
import { ReopenDialog } from '@/kit/close/ReopenDialog';
import { ErrorState } from '@/kit/states/ErrorState';
import { ForbiddenState } from '@/kit/states/ForbiddenState';
import { LoadingState } from '@/kit/states/LoadingState';

const CLOSE = 'ledger.period.close', REOPEN = 'ledger.period.reopen';

/** AC6: close the months in order (a checklist the server computes), reopen the latest one with a reason, and close the fiscal year once all twelve months are closed. */
export default function PeriodClosePage() {
  return <Inner key={useCompanyEpoch()} />;
}

function Inner() {
  const { me, isPending: mePending, error: meError, refetch: refetchMe } = useMe();
  const [year, setYear] = useState<number>();
  const q = useQuery({ queryKey: [me?.activeCompanyId ?? '', 'periods', year ?? ''], queryFn: () => endpoints.getPeriods(year), enabled: !!me, placeholderData: (prev) => prev });
  if (meError) return <ErrorState error={meError} onRetry={() => void refetchMe()} />;
  if (mePending || (q.isPending && !q.data)) return <LoadingState />;
  if (q.error && !q.data) return isForbidden(q.error) ? <ForbiddenState permission="ledger.read" detail={q.error instanceof ApiError ? q.error.problem.detail : undefined} /> : <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  return <Loaded view={q.data!} perms={me!.permissions} companyId={me!.activeCompanyId} onYear={setYear} />;
}

function Loaded({ view, perms, companyId, onYear }: { view: PeriodsView; perms: string[]; companyId: string; onYear: (y: number) => void }) {
  const t = useTranslations('periodClose');
  const qc = useQueryClient();
  const [picked, setPicked] = useState<string>();
  const [ack, setAck] = useState(false);
  const [reopening, setReopening] = useState<{ kind: 'month'; month: string } | { kind: 'year' }>();
  const month = picked && view.months.some((m) => m.month === picked) ? picked : view.next.close && view.months.some((m) => m.month === view.next.close) ? view.next.close : view.months.find((m) => m.status === 'open')?.month ?? view.months.at(-1)?.month;
  const checklist = useQuery({ queryKey: [companyId, 'periods', 'checklist', month, view.months.find((m) => m.month === month)?.status], queryFn: () => endpoints.getChecklist(month!), enabled: !!month });
  const refresh = () => qc.invalidateQueries({ queryKey: [companyId] });
  const close = useMutation({ mutationFn: () => endpoints.closePeriod(month!, ack ? (checklist.data?.items ?? []).filter((i) => i.severity === 'warning' && i.count > 0).map(({ code, count }) => ({ code, count })) : []), onSuccess: async () => { setAck(false); setPicked(undefined); await refresh(); } });
  const reopen = useMutation({
    mutationFn: (reason: string) => (reopening?.kind === 'year' ? endpoints.reopenYear(view.year, reason) : endpoints.reopenPeriod((reopening as { month: string }).month, reason)),
    onSuccess: async () => { setReopening(undefined); setPicked(undefined); await refresh(); },
  });
  const closeYear = useMutation({ mutationFn: () => endpoints.closeYear(view.year), onSuccess: refresh });
  const period = view.months.find((m) => m.month === month);
  const yc = view.yearClose;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-h1 font-semibold">{t('title')}</h1>
        <label className="flex items-center gap-2 text-body">
          <span className="text-small text-muted-foreground">{t('year')}</span>
          <select className="h-(--ctl-h) rounded-lg border border-input bg-card px-3 text-body" value={view.year} onChange={(e) => { setPicked(undefined); onYear(Number(e.target.value)); }} data-testid="year-select">
            {view.years.map((y) => <option key={y} value={y}>{y + 543}</option>)}
          </select>
        </label>
      </header>
      <p className="text-small text-muted-foreground">{t('lead')}</p>

      <PeriodGrid view={view} selected={month} canReopen={perms.includes(REOPEN)} onSelect={(m) => { close.reset(); setAck(false); setPicked(m); }} onReopen={(m) => { reopen.reset(); setReopening({ kind: 'month', month: m }); }} />

      {month && checklist.data ? (
        <ChecklistPanel month={month} period={period} items={checklist.data.items} canClose={perms.includes(CLOSE)} isNext={month === view.next.close} acknowledged={ack} onAcknowledged={setAck} pending={close.isPending} error={close.error} onClose={() => close.mutate()} />
      ) : checklist.error ? <ErrorState error={checklist.error} onRetry={() => void checklist.refetch()} /> : null}

      <section aria-label={t('yearSection', { year: view.year + 543 })} className="grid gap-3 rounded-lg border bg-card p-4" data-testid="year-close">
        <h2 className="text-section font-semibold">{t('yearTitle', { year: view.year + 543 })}</h2>
        {yc ? (
          <>
            <p data-testid="year-status">{t('yearClosed', { at: formatDateBE(yc.closedAt.slice(0, 10)), by: yc.closedBy })}</p>
            <p>{t(Number(yc.net) >= 0 ? 'netProfit' : 'netLoss', { amount: formatMoney(yc.net.replace('-', '')) })}</p>
            <div role="region" aria-label={t('closingEntry')} tabIndex={0} className="overflow-x-auto rounded-lg border [&_[data-slot=table-container]]:overflow-visible">
              <Table>
                <TableHeader><TableRow><TableHead>{t('account')}</TableHead><TableHead className="text-right">{t('debit')}</TableHead><TableHead className="text-right">{t('credit')}</TableHead></TableRow></TableHeader>
                <TableBody>
                  {yc.lines.map((l, i) => (
                    <TableRow key={i}><TableCell>{l.accountCode} {l.accountName}</TableCell><TableCell className="text-right tabular-nums">{Number(l.debit) ? formatMoney(l.debit) : ''}</TableCell><TableCell className="text-right tabular-nums">{Number(l.credit) ? formatMoney(l.credit) : ''}</TableCell></TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <div><Button variant="outline" disabled={!perms.includes(REOPEN)} onClick={() => { reopen.reset(); setReopening({ kind: 'year' }); }}>{t('reopenYear', { year: view.year + 543 })}</Button></div>
          </>
        ) : (
          <>
            <p className="text-muted-foreground">{view.next.closeYear ? t('yearReady') : t('yearNotReady')}</p>
            {closeYear.error ? <Alert variant="destructive" role="alert"><AlertTitle>{closeYear.error instanceof ApiError ? closeYear.error.problem.title : ''}</AlertTitle></Alert> : null}
            <div><Button disabled={!view.next.closeYear || !perms.includes(CLOSE) || closeYear.isPending} onClick={() => closeYear.mutate()}>{closeYear.isPending ? t('closingYear') : t('closeYear', { year: view.year + 543 })}</Button></div>
          </>
        )}
        {view.yearReopened.length ? <ul className="text-small text-muted-foreground" aria-label={t('yearHistory')}>{view.yearReopened.map((r, i) => <li key={i}>{formatDateBE(r.at.slice(0, 10))} · {r.by} · {r.reason}</li>)}</ul> : null}
      </section>

      {reopening ? (
        <ReopenDialog
          title={reopening.kind === 'year' ? t('reopen.yearTitle', { year: view.year + 543 }) : t('reopen.monthTitle', { month: monthBE(reopening.month) })}
          body={reopening.kind === 'year' ? t('reopen.yearBody') : t('reopen.monthBody')}
          pending={reopen.isPending} error={reopen.error} onConfirm={(reason) => reopen.mutate(reason)} onClose={() => setReopening(undefined)}
        />
      ) : null}
    </div>
  );
}
