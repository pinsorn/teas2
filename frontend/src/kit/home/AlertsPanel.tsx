'use client';
import { AlertTriangleIcon } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { HomeSectionShell, useHomeSection } from './HomeSection';

/** Number gaps / duplicates (RP3), the VAT threshold (TX3), incomplete vendor bills (P2), old drafts, depreciation due (AC6): each row is its engine's answer and links to where it is fixed. */
export function AlertsPanel() {
  const t = useTranslations('home.alerts');
  const q = useHomeSection('alerts');
  return (
    <HomeSectionShell id="h-alerts" title={t('title')} q={q} isEmpty={(d) => !d.length} empty={t('empty')}>
      {(d) => (
        <ul className="divide-y">
          {d.map((a) => (
            <li key={a.code} data-testid={`alert-${a.code}`} data-severity={a.severity} className="flex items-center justify-between gap-3 py-2">
              <span className="flex min-w-0 items-center gap-2 text-body">
                <AlertTriangleIcon aria-hidden className={a.severity === 'danger' ? 'size-4 shrink-0 text-destructive' : 'size-4 shrink-0 text-muted-foreground'} />
                {t(a.code, { count: a.count, percent: a.percent ?? '' })}
              </span>
              <Link href={a.href} className="shrink-0 text-small underline-offset-4 hover:underline">{t('open')}</Link>
            </li>
          ))}
        </ul>
      )}
    </HomeSectionShell>
  );
}
