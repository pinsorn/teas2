'use client';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useMe } from '@/app-shell/useMe';
import { usePartyNames } from './fields';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { Doc } from '@/domain/types';
import { endpoints } from '@/lib/api/endpoints';
import { formatDateBE, formatMoney } from '@/lib/format';

/** What an issued (or draft) opening balance holds, step by step: the trial-balance lines and the steps behind them, exactly as stored. The figures are the document's own; nothing is added up here. */
export function ObSummary({ doc }: { doc: Doc }) {
  const t = useTranslations('opening');
  const tv = useTranslations('opening.view');
  const { me } = useMe();
  const op = doc.opening;
  const partyName = usePartyNames();
  const banks = useQuery({ queryKey: [me?.activeCompanyId ?? '', 'opening-bank-accounts'], queryFn: () => endpoints.listRecords('bank-account', { limit: 100 }), enabled: !!me && !!op?.bank.length });
  const bankName = (id: string) => String(banks.data?.items.find((b) => b.id === id)?.name ?? id);
  const empty = <p className="text-body text-muted-foreground">{tv('none')}</p>;
  return (
    <div className="grid gap-6 text-body" data-testid="ob-summary">
      <section aria-label={t('steps.tb')} className="grid gap-2">
        <h2 className="text-title font-semibold">{t('steps.tb')}</h2>
        {doc.lines.length ? (
          <Table>
            <TableHeader><TableRow><TableHead>{t('review.account')}</TableHead><TableHead className="text-right">{t('review.debit')}</TableHead><TableHead className="text-right">{t('review.credit')}</TableHead></TableRow></TableHeader>
            <TableBody>
              {doc.lines.map((l) => (
                <TableRow key={l.id}>
                  <TableCell className="whitespace-normal">{l.accountCode} {l.description}</TableCell>
                  <TableCell className="text-right tabular-nums">{Number(l.debit) ? formatMoney(l.debit!) : ''}</TableCell>
                  <TableCell className="text-right tabular-nums">{Number(l.credit) ? formatMoney(l.credit!) : ''}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : empty}
      </section>
      <section aria-label={t('steps.bank')} className="grid gap-2">
        <h2 className="text-title font-semibold">{t('steps.bank')}</h2>
        {op?.bank.length ? op.bank.map((b) => (
          <div key={b.accountId} className="grid gap-1 rounded-lg border border-border p-3">
            <p className="font-medium">{bankName(b.accountId)} · {tv('bankStatement')} <span className="tabular-nums">{formatMoney(b.statement)}</span></p>
            {b.inTransit.map((x, i) => <p key={i} className="text-small">{t(`bank.${x.kind}`)} · {formatDateBE(x.date)} · {x.description} · <span className="tabular-nums">{formatMoney(x.amount)}</span></p>)}
          </div>
        )) : empty}
      </section>
      <section aria-label={t('steps.items')} className="grid gap-2">
        <h2 className="text-title font-semibold">{t('steps.items')}</h2>
        {op?.openItems.length ? (
          <Table>
            <TableHeader><TableRow><TableHead>{tv('side')}</TableHead><TableHead>{tv('party')}</TableHead><TableHead>{tv('doc')}</TableHead><TableHead className="text-right">{tv('amount')}</TableHead></TableRow></TableHeader>
            <TableBody>
              {op.openItems.map((x, i) => (
                <TableRow key={i}><TableCell>{t(`items.sides.${x.side}`)}</TableCell><TableCell className="whitespace-normal">{partyName(x.partyId)}</TableCell><TableCell>{x.docNumber} · {formatDateBE(x.docDate)}</TableCell><TableCell className="text-right tabular-nums">{formatMoney(x.amount)}</TableCell></TableRow>
              ))}
            </TableBody>
          </Table>
        ) : empty}
      </section>
      <section aria-label={t('steps.assets')} className="grid gap-2">
        <h2 className="text-title font-semibold">{t('steps.assets')}</h2>
        {op?.assets.length ? (
          <Table>
            <TableHeader><TableRow><TableHead>{tv('asset')}</TableHead><TableHead className="text-right">{tv('cost')}</TableHead><TableHead className="text-right">{tv('accumulated')}</TableHead></TableRow></TableHeader>
            <TableBody>
              {op.assets.map((a, i) => <TableRow key={i}><TableCell className="whitespace-normal">{a.name} · {formatDateBE(a.acquired)}</TableCell><TableCell className="text-right tabular-nums">{formatMoney(a.cost)}</TableCell><TableCell className="text-right tabular-nums">{formatMoney(a.accumulated)}</TableCell></TableRow>)}
            </TableBody>
          </Table>
        ) : empty}
      </section>
      <section aria-label={t('steps.payroll')} className="grid gap-2">
        <h2 className="text-title font-semibold">{t('steps.payroll')}</h2>
        {op?.payrollYtd.length ? (
          <Table>
            <TableHeader><TableRow><TableHead>{tv('employee')}</TableHead><TableHead className="text-right">{tv('income')}</TableHead><TableHead className="text-right">{tv('pit')}</TableHead><TableHead className="text-right">{tv('sso')}</TableHead></TableRow></TableHeader>
            <TableBody>
              {op.payrollYtd.map((y, i) => <TableRow key={i}><TableCell>{partyName(y.employeeId)}</TableCell><TableCell className="text-right tabular-nums">{formatMoney(y.income)}</TableCell><TableCell className="text-right tabular-nums">{formatMoney(y.pit)}</TableCell><TableCell className="text-right tabular-nums">{formatMoney(y.sso)}</TableCell></TableRow>)}
            </TableBody>
          </Table>
        ) : empty}
      </section>
    </div>
  );
}
