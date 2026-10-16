'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useCompanyEpoch } from '@/app-shell/useCompanyEpoch';
import { isForbidden, useMe } from '@/app-shell/useMe';
import { docViewHref } from '@/descriptors';
import type { SettlementLeg, SettlementRecord } from '@/domain/types';
import { ApiError } from '@/lib/api/client';
import { endpoints } from '@/lib/api/endpoints';
import { formatDateBE, formatMoney } from '@/lib/format';
import { qk } from '@/lib/query/keys';
import { ErrorState } from '@/kit/states/ErrorState';
import { ForbiddenState } from '@/kit/states/ForbiddenState';
import { LoadingState } from '@/kit/states/LoadingState';
import { NotFoundState } from '@/kit/states/NotFoundState';

const MANAGE = 'bank.manage';

/** FN3: one settlement record - what it applied, the difference, its journal (with the reversal) - and the exit for every settlement: reverse it. Everything shown is what was frozen at posting. */
export default function SettlementPage() {
  return <SettlementInner key={useCompanyEpoch()} />;
}

function SettlementInner() {
  const { id } = useParams<{ id: string }>();
  const t = useTranslations('settlement');
  const { me, isPending: mePending, error: meError, refetch: refetchMe } = useMe();
  const q = useQuery({ queryKey: qk.settlement(me?.activeCompanyId ?? '', id), queryFn: () => endpoints.getSettlement(id), enabled: !!me });
  if (meError) return <ErrorState error={meError} onRetry={() => void refetchMe()} />;
  if (mePending || q.isPending) return <LoadingState />;
  if (q.error) {
    if (q.error instanceof ApiError && q.error.code === 'settlement.not_found') return <NotFoundState listHref="/finance/settlements" title={t('notFoundTitle')} body={t('notFoundBody')} />;
    return isForbidden(q.error) ? <ForbiddenState permission="bank.read" detail={q.error instanceof ApiError ? q.error.problem.detail : undefined} /> : <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  }
  return <Loaded s={q.data} canManage={me!.permissions.includes(MANAGE)} companyId={me!.activeCompanyId} />;
}

function Loaded({ s, canManage, companyId }: { s: SettlementRecord; canManage: boolean; companyId: string }) {
  const t = useTranslations('settlement');
  const td = useTranslations('settlement.detail');
  const qc = useQueryClient();
  const hintId = useId(), reasonId = useId();
  const [confirm, setConfirm] = useState(false);
  const [reason, setReason] = useState('');
  const reverse = useMutation({
    mutationFn: () => endpoints.reverseSettlement(s.id, reason.trim()),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: [companyId] }); setConfirm(false); },
  });
  const legs = (list: SettlementLeg[], label: string) => (
    <section aria-label={label} className="grid gap-1.5">
      <h2 className="text-section font-semibold">{label}</h2>
      <div role="region" aria-label={label} tabIndex={0} className="overflow-x-auto rounded-lg border bg-card [&_[data-slot=table-container]]:overflow-visible">
        <Table>
          <TableHeader><TableRow><TableHead>{td('document')}</TableHead><TableHead>{td('party')}</TableHead><TableHead className="text-right">{td('amount')}</TableHead></TableRow></TableHeader>
          <TableBody>
            {list.map((l) => {
              const href = l.type ? docViewHref(l.type, l.docId) : undefined;
              return (
                <TableRow key={l.docId}>
                  <TableCell className="tabular-nums">{href ? <Link href={href} className="text-primary hover:underline">{l.type} {l.number}</Link> : `${l.type ?? ''} ${l.number ?? l.docId}`}</TableCell>
                  <TableCell>{l.partyName}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(l.amount)}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </section>
  );
  const reversed = s.status === 'reversed';

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
      <header className="grid gap-2">
        <p className="text-small text-muted-foreground"><Link href="/finance/settlements" className="hover:underline">{t('list.title')}</Link></p>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-h1 font-semibold tabular-nums">{s.id.toUpperCase()}</h1>
          <Badge variant={reversed ? 'outline' : 'secondary'}>{t(`status.${s.status}`)}</Badge>
        </div>
        <dl className="grid grid-cols-[repeat(auto-fit,minmax(10rem,1fr))] gap-x-6 gap-y-2 text-body">
          <div><dt className="text-small text-muted-foreground">{td('kind')}</dt><dd>{t(`kinds.${s.kind}`)}</dd></div>
          <div><dt className="text-small text-muted-foreground">{td('date')}</dt><dd className="tabular-nums">{formatDateBE(s.date)}</dd></div>
          <div><dt className="text-small text-muted-foreground">{td('party')}</dt><dd>{s.targets[0]?.partyName}{s.counterPartyId && s.sources[0]?.partyName ? ` ⇄ ${s.sources[0].partyName}` : ''}</dd></div>
          {s.difference ? <div><dt className="text-small text-muted-foreground">{td('difference')}</dt><dd className="tabular-nums">{t(`roles.${s.difference.role}`)} · {formatMoney(s.difference.amount)}</dd></div> : null}
          {s.reason ? <div><dt className="text-small text-muted-foreground">{td('reason')}</dt><dd>{s.reason}</dd></div> : null}
        </dl>
        {reversed ? (
          <Alert role="status"><AlertTitle>{td('reversedTitle', { at: formatDateBE(s.reversal?.at.slice(0, 10) ?? s.date), by: s.reversal?.by.name ?? '' })}</AlertTitle>{s.reversal?.reason ? <AlertDescription>{s.reversal.reason}</AlertDescription> : null}</Alert>
        ) : (
          <div className="flex flex-wrap items-start gap-2">
            <span className="inline-flex flex-col items-start gap-1">
              <Button variant="outline" disabled={!canManage} aria-describedby={canManage ? undefined : hintId} onClick={() => { reverse.reset(); setReason(''); setConfirm(true); }}>{td('reverse')}</Button>
              {canManage ? null : <span id={hintId} className="text-small text-muted-foreground">{t('needManage', { permission: MANAGE })}</span>}
            </span>
          </div>
        )}
      </header>
      {s.sources.length ? legs(s.sources, t(`sources.${s.kind}`)) : null}
      {legs(s.targets, t(`targets.${s.kind === 'write_off' ? (s.targets[0]?.type === 'PB' ? 'apply_prepayment' : 'apply_deposit') : s.kind}`))}
      <section aria-label={td('journal')} className="grid gap-2">
        <h2 className="text-section font-semibold">{td('journal')}</h2>
        {s.journal.map((e) => (
          <div key={e.kind} role="region" aria-label={`${td(`entry.${e.kind}`)} ${formatDateBE(e.date)}`} tabIndex={0} className="overflow-x-auto rounded-lg border bg-card [&_[data-slot=table-container]]:overflow-visible">
            <p className="px-3 pt-2 text-small font-medium text-muted-foreground">{td(`entry.${e.kind}`)} · {formatDateBE(e.date)}{e.late ? ` · ${td('late')}` : ''}</p>
            <Table>
              <TableHeader><TableRow><TableHead>{td('account')}</TableHead><TableHead>{td('party')}</TableHead><TableHead className="text-right">{td('debit')}</TableHead><TableHead className="text-right">{td('credit')}</TableHead></TableRow></TableHeader>
              <TableBody>
                {e.lines.map((l, i) => (
                  <TableRow key={i}>
                    <TableCell>{l.accountCode} {l.accountName}</TableCell><TableCell>{l.partyName ?? ''}</TableCell>
                    <TableCell className="text-right tabular-nums">{l.debit === '0.00' ? '' : formatMoney(l.debit)}</TableCell>
                    <TableCell className="text-right tabular-nums">{l.credit === '0.00' ? '' : formatMoney(l.credit)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ))}
      </section>
      {confirm ? (
        <AlertDialog open onOpenChange={(o) => { if (!o) setConfirm(false); }}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{td('reverseTitle', { id: s.id.toUpperCase() })}</AlertDialogTitle>
              <AlertDialogDescription>{td('reverseBody')}</AlertDialogDescription>
            </AlertDialogHeader>
            <div className="grid gap-1.5">
              <Label htmlFor={reasonId}>{td('reasonLabel')}</Label>
              <Input id={reasonId} value={reason} onChange={(e) => setReason(e.target.value)} />
            </div>
            {reverse.error ? (
              <Alert variant="destructive" role="alert"><AlertTitle>{reverse.error instanceof ApiError ? reverse.error.problem.title : td('failed')}</AlertTitle></Alert>
            ) : null}
            <AlertDialogFooter>
              <AlertDialogCancel>{td('cancel')}</AlertDialogCancel>
              <Button disabled={!reason.trim() || reverse.isPending} onClick={() => reverse.mutate()}>{reverse.isPending ? td('reversing') : td('reverseConfirm')}</Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
    </div>
  );
}
