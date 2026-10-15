'use client';
import { useTranslations } from 'next-intl';
import type { DocTotals, WhtLine } from '@/domain/types';
import { formatMoney } from '@/lib/format';

/** Rows inside the totals list for a receipt / voucher: withholding tax (per type below it) and the money that moves.
 *  Everything is the server's figure ([SP-R] mock rates); the browser only formats it. */
export function WhtSummary({ totals, whtLines }: { totals: DocTotals; whtLines?: WhtLine[] }) {
  const t = useTranslations('docEditor.whtSummary');
  return (
    <>
      <div className="flex justify-between gap-4"><dt className="text-muted-foreground">{t('wht')}</dt><dd className="tabular-nums">{formatMoney(totals.wht ?? '0.00')}</dd></div>
      {whtLines?.length ? (
        <div className="grid gap-1 pl-3 text-small text-muted-foreground" role="group" aria-label={t('title')}>
          {whtLines.map((l) => (
            <div key={l.code} className="flex flex-wrap justify-between gap-x-4">
              <span>{`${l.nameTh} ${l.rate} · ${t('base')} ${formatMoney(l.base)} · ${t(`forms.${l.form}`)} · ${t('payee')} ${formatMoney(l.net)}`}</span>
              <span className="tabular-nums">{formatMoney(l.tax)}</span>
            </div>
          ))}
        </div>
      ) : null}
      <div className="flex justify-between gap-4 font-semibold"><dt>{t('cash')}</dt><dd className="tabular-nums">{formatMoney(totals.cash ?? totals.total)}</dd></div>
    </>
  );
}
