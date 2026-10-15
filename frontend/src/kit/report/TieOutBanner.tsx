import { TriangleAlertIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { TieOut } from '@/domain/reports';
import { formatMoney } from '@/lib/format';

/** Amber status banner for every tie-out whose server-computed `diff` is not 0.00; names both sides. Renders nothing when all tie out. */
export function TieOutBanner({ tieOuts }: { tieOuts: TieOut[] }) {
  const t = useTranslations();
  const dyn = t as unknown as (key: string, v: Record<string, string>) => string; // server-supplied label keys are not statically known
  const bad = tieOuts.filter((o) => o.diff !== '0.00');
  if (!bad.length) return null;
  return (
    <div role="status" aria-label={t('reports.tieOut.title')}
      className="flex gap-3 rounded-lg border border-(--color-status-pending-fg)/30 bg-(--color-status-pending-bg) p-3 text-body text-(--color-status-pending-fg)">
      <TriangleAlertIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
      <div className="grid gap-1">
        <p className="font-medium">{t('reports.tieOut.title')}</p>
        {bad.map((o) => (
          <p key={o.labelKey} className="tabular-nums">
            {dyn(o.labelKey, { left: formatMoney(o.left), right: formatMoney(o.right) })} {t('reports.tieOut.diff', { diff: formatMoney(o.diff) })}
          </p>
        ))}
      </div>
    </div>
  );
}
