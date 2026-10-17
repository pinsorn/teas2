'use client';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { docViewHref } from '@/descriptors';
import type { DpRow, Money } from '@/domain/types';
import { formatDateBE, formatMoney } from '@/lib/format';

/** "ก.ค. 2569" for the month "2026-07". */
export const monthTh = (month: string) => formatDateBE(`${month}-01`).replace(/^1 /, '');
const monthAfter = (month: string, n: number) => { const i = Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1 + n; return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`; };
/** An asset class by its Thai label (the code when none is known): the code is what the asset froze, the label is display only. */
export function useClassLabel(): (code: string) => string {
  const t = useTranslations('opening.assets.classes');
  return (code) => (t.has(code as never) ? t(code as never) : code);
}

/** The per-asset rows of a depreciation run, before it is issued (the preview) or as stored (the run's own view). The figures are the server's; nothing is added up here. */
export function DepreciationPreview({ rows, total }: { rows: DpRow[]; total: Money }) {
  const t = useTranslations('assets.dp');
  const label = useClassLabel();
  if (!rows.length) return <p className="text-body text-muted-foreground" data-testid="dp-empty">{t('noRows')}</p>;
  return (
    <div className="overflow-x-auto" role="region" aria-label={t('rowsLabel')} tabIndex={0}>
      <Table data-testid="dp-rows">
        <TableHeader><TableRow>
          <TableHead>{t('asset')}</TableHead><TableHead>{t('class')}</TableHead><TableHead>{t('accounts')}</TableHead><TableHead className="text-right">{t('amount')}</TableHead>
        </TableRow></TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.assetId}>
              <TableCell className="whitespace-normal">{docViewHref('FA', r.assetId) ? <Link className="underline underline-offset-2" href={docViewHref('FA', r.assetId)!}>{r.assetNumber ?? r.assetId}</Link> : r.assetNumber ?? r.assetId} · {r.name}{r.catchUp ? <span className="block text-small text-muted-foreground" data-testid="dp-catchup">{t('catchUp', { from: monthTh(r.catchUp.from), to: monthTh(monthAfter(r.catchUp.from, r.catchUp.months - 1)), months: r.catchUp.months })}</span> : null}</TableCell>
              <TableCell>{label(r.assetClass)}</TableCell>
              <TableCell className="tabular-nums">{r.expenseCode} / {r.accumulatedCode}</TableCell>
              <TableCell className="text-right tabular-nums">{formatMoney(r.amount)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
        <TableFooter><TableRow><TableCell colSpan={3} className="font-medium">{t('total')}</TableCell><TableCell className="text-right font-medium tabular-nums" data-testid="dp-total">{formatMoney(total)}</TableCell></TableRow></TableFooter>
      </Table>
    </div>
  );
}
