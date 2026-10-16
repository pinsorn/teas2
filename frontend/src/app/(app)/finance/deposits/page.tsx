'use client';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useCompanyEpoch } from '@/app-shell/useCompanyEpoch';
import { isForbidden, useMe } from '@/app-shell/useMe';
import type { DepositRow } from '@/domain/types';
import { ApiError } from '@/lib/api/client';
import { endpoints } from '@/lib/api/endpoints';
import { formatDateBE, formatMoney } from '@/lib/format';
import { qk } from '@/lib/query/keys';
import { SettlementForm } from '@/kit/settlement/SettlementForm';
import { EmptyState } from '@/kit/states/EmptyState';
import { ErrorState } from '@/kit/states/ErrorState';
import { ForbiddenState } from '@/kit/states/ForbiddenState';
import { LoadingState } from '@/kit/states/LoadingState';

const MANAGE = 'bank.manage';

/** FN3: customer deposits (RC deposit remainders not yet applied) and vendor prepayments (PV prepayments not yet applied), each with the way to apply it to an open document. Applying is a settlement record (D-13). */
export default function DepositsPage() {
  return <DepositsInner key={useCompanyEpoch()} />;
}

function DepositsInner() {
  const t = useTranslations('settlement');
  const td = useTranslations('settlement.deposits');
  const router = useRouter();
  const hintId = useId();
  const { me, isPending: mePending, error: meError, refetch: refetchMe } = useMe();
  const q = useQuery({ queryKey: qk.deposits(me?.activeCompanyId ?? ''), queryFn: () => endpoints.getDeposits(), enabled: !!me });
  const [form, setForm] = useState<{ initial?: { docId: string; type: 'RC' | 'PV'; partyId: string } } | undefined>();
  if (meError) return <ErrorState error={meError} onRetry={() => void refetchMe()} />;
  if (mePending || q.isPending) return <LoadingState />;
  if (q.error) return isForbidden(q.error) ? <ForbiddenState permission="bank.read" detail={q.error instanceof ApiError ? q.error.problem.detail : undefined} /> : <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const canManage = me!.permissions.includes(MANAGE);
  const customer = q.data.items.filter((r) => r.type === 'RC'), vendor = q.data.items.filter((r) => r.type === 'PV');

  const table = (rows: DepositRow[], kind: 'customer' | 'vendor') => (
    <section aria-labelledby={`${hintId}-${kind}`} className="grid gap-2">
      <h2 id={`${hintId}-${kind}`} className="text-section font-semibold">{td(`${kind}.title`)}</h2>
      {rows.length === 0 ? <p className="text-muted-foreground">{td(`${kind}.empty`)}</p> : (
        <div role="region" aria-label={td(`${kind}.title`)} tabIndex={0} className="overflow-x-auto rounded-lg border bg-card [&_[data-slot=table-container]]:overflow-visible">
          <Table>
            <TableHeader><TableRow>
              <TableHead>{td('number')}</TableHead><TableHead>{td('party')}</TableHead><TableHead>{td('date')}</TableHead>
              <TableHead className="text-right">{td('amount')}</TableHead><TableHead className="text-right">{td('applied')}</TableHead><TableHead className="text-right">{td('remaining')}</TableHead><TableHead><span className="sr-only">{td('actions')}</span></TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.docId}>
                  <TableCell className="tabular-nums"><Link href={`${r.type === 'RC' ? '/sales/receipts' : '/purchases/payment-vouchers'}/${r.docId}`} className="text-primary hover:underline">{r.number}</Link></TableCell>
                  <TableCell>{r.partyName}</TableCell>
                  <TableCell className="tabular-nums">{formatDateBE(r.documentDate)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(r.amount)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(r.applied)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(r.remaining)}</TableCell>
                  <TableCell>
                    <Button size="sm" variant="outline" disabled={!canManage} aria-describedby={canManage ? undefined : hintId}
                      onClick={() => setForm({ initial: { docId: r.docId, type: r.type, partyId: r.partyId } })}>{td(`${kind}.apply`)}<span className="sr-only"> {r.number}</span></Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
      <header className="grid gap-2">
        <h1 className="text-title font-semibold">{td('title')}</h1>
        <p className="text-muted-foreground" data-testid="deposit-vat-note">{t('vatNote')}</p>
        <div className="flex flex-wrap items-start gap-2">
          <span className="inline-flex flex-col items-start gap-1">
            <Button disabled={!canManage} aria-describedby={canManage ? undefined : hintId} onClick={() => setForm({})}>{td('new')}</Button>
            {canManage ? null : <span id={hintId} className="text-small text-muted-foreground">{t('needManage', { permission: MANAGE })}</span>}
          </span>
          <Button asChild variant="outline"><Link href="/finance/settlements">{td('history')}</Link></Button>
        </div>
      </header>
      {q.data.items.length === 0 ? <EmptyState title={td('empty')} body={td('emptyBody')} /> : null}
      {table(customer, 'customer')}
      {table(vendor, 'vendor')}
      {form ? <SettlementForm initial={form.initial} onClose={() => setForm(undefined)} onPosted={(s) => router.push(`/finance/settlements/${s.id}`)} /> : null}
    </div>
  );
}
