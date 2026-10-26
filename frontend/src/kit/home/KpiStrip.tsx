'use client';
import { useTranslations } from 'next-intl';
import { formatTHB } from '@/lib/format';
import { HomeSectionShell, useHomeSection } from './HomeSection';

/** The figures come from the server's engines (RP2 aging totals, the journal's bank / cash accounts, the ภ.พ.30); a non-VAT company has no VAT tile at all, never a "0". */
export function KpiStrip() {
  const t = useTranslations('home.kpi');
  const q = useHomeSection('kpis');
  return (
    <HomeSectionShell id="h-kpis" title={t('label')} q={q} isEmpty={() => false} empty="" rows={1}>
      {(k) => {
        const tiles = ([['cash', k.cash], ['ar', k.ar], ['ap', k.ap], ['vat', k.vatThisMonth]] as const).flatMap(([key, v]) => (v === null ? [] : [[key, v] as [string, string]]));
        return (
          <dl aria-label={t('label')} className="grid grid-cols-2 gap-x-6 gap-y-3 lg:grid-cols-4">
            {tiles.map(([key, value]) => (
              <div key={key}>
                <dt className="text-small text-muted-foreground">{t(key)}</dt>
                <dd className="text-title font-semibold tabular-nums" data-testid={`kpi-${key}`}>{formatTHB(value)}</dd>
              </div>
            ))}
          </dl>
        );
      }}
    </HomeSectionShell>
  );
}
