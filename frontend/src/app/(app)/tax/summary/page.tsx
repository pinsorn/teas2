'use client';
import { useTranslations } from 'next-intl';
import type { ReportParamSpec } from '@/domain/reports';
import { VatThresholdCard } from '@/kit/tax/VatThresholdCard';
import { ReportView } from '@/kit/report/ReportView';

const PARAMS: ReportParamSpec[] = [{ key: 'year', kind: 'year', labelKey: 'reports.taxSummary.year' }];

/** TX3b: the monthly tax summary of one calendar year (`?year=`, empty = the year of the server's today) with the VAT threshold watch above it for a company outside VAT. tax.read to view. */
export default function TaxSummaryPage() {
  const t = useTranslations();
  return (
    <div className="grid gap-4">
      <h1 className="text-title font-semibold">{t('nav.items.taxSummary')}</h1>
      <VatThresholdCard />
      <ReportView kind="tax-summary" params={PARAMS} defaults={{}} />
    </div>
  );
}
