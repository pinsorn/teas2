'use client';
import { useTranslations } from 'next-intl';
import type { DocTotals } from '@/domain/types';
import { formatMoney } from '@/lib/format';
import { ErrorState } from '../states/ErrorState';

const Row = ({ label, value }: { label: string; value?: string }) => (
  <div className="flex justify-between gap-4"><dt className="text-muted-foreground">{label}</dt><dd className="tabular-nums">{value}</dd></div>
);

/** Everything here is what the server computed; the browser only formats it. */
export function TotalsPanel({ totals, pending, error, onRetry }: { totals?: DocTotals; pending: boolean; error?: unknown; onRetry: () => void }) {
  const t = useTranslations('docEditor.totals');
  const show = !pending && !error && totals;
  return (
    <section aria-label={t('title')} className="grid gap-2 rounded-xl bg-card p-4 ring-1 ring-foreground/10">
      <h2 className="text-section font-semibold">{t('title')}</h2>
      {error ? <div role="presentation"><ErrorState error={error} onRetry={onRetry} /></div> : (
        <dl className="grid gap-1 text-body" aria-busy={pending}>
          <Row label={t('net')} value={show ? formatMoney(totals.net) : undefined} />
          <Row label={t('vat')} value={show ? formatMoney(totals.vat) : undefined} />
          {show && totals.wht && <Row label={t('wht')} value={formatMoney(totals.wht)} />}
          <div className="mt-1 flex justify-between gap-4 border-t border-foreground pt-2 font-semibold">
            <dt>{t('total')}</dt><dd className="tabular-nums">{show ? formatMoney(totals.total) : undefined}</dd>
          </div>
        </dl>
      )}
      <p role="status" className="text-small text-muted-foreground">{pending ? t('computing') : show ? totals.amountInWords : ''}</p>
    </section>
  );
}
