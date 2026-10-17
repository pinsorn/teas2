'use client';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangleIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useMe } from '@/app-shell/useMe';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { endpoints } from '@/lib/api/endpoints';
import { formatDateBE, formatTHB } from '@/lib/format';
import { qk } from '@/lib/query/keys';

/** G1: how close a company outside VAT is to the registration threshold. Shown only for a non-VAT company (the answer is null for a VAT one) and only to someone who may read tax; silent on a failure (Home must not break). */
export function VatThresholdCard() {
  const t = useTranslations('taxPage.threshold');
  const { me } = useMe();
  const companyId = me?.activeCompanyId ?? '';
  const q = useQuery({ queryKey: qk.vatThreshold(companyId), queryFn: endpoints.getVatThreshold, enabled: !!companyId && me?.vatRegistered === false && me.permissions.includes('tax.read') });
  const w = q.data;
  if (!w) return null;
  const pct = Math.min(Number(w.percent), 100), alarm = w.level !== 'ok';
  return (
    <Alert role="status" data-testid="vat-threshold" data-level={w.level} variant={w.level === 'danger' ? 'destructive' : 'default'}>
      {alarm ? <AlertTriangleIcon aria-hidden /> : null}
      <AlertTitle>{t('title')}: {w.percent}%</AlertTitle>
      <AlertDescription className="grid gap-2">
        {alarm ? <p className="font-medium text-foreground" data-testid="vat-threshold-message">{t(`message.${w.level}` as never)}</p> : <p>{t('ok')}</p>}
        <div role="progressbar" aria-label={t('bar')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} className="h-2 w-full rounded bg-muted">
          <div className={w.level === 'danger' ? 'h-2 rounded bg-destructive' : 'h-2 rounded bg-primary'} style={{ width: `${pct}%` }} />
        </div>
        <p className="tabular-nums">{t('revenue')} {formatTHB(w.revenue)} {t('of', { threshold: formatTHB(w.threshold) })}</p>
        <p className="text-small tabular-nums">{t('window', { from: formatDateBE(w.from), to: formatDateBE(w.to) })}</p>
      </AlertDescription>
    </Alert>
  );
}
