import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import type { ReportParamSpec } from '@/domain/reports';
import { ReportView } from '@/kit/report/ReportView';

// the fixed-asset register as of a date (blank = today): cost, accumulated depreciation and net book value per asset and class, tied to the ledger; the server lays it out (report.read)
const PARAMS: ReportParamSpec[] = [{ key: 'asOf', kind: 'date', labelKey: 'reports.asOf' }];

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations())('nav.items.assetRegister') };
}
export default async function Page() {
  const t = await getTranslations();
  return (
    <div className="grid gap-4">
      <h1 className="text-title font-semibold">{t('nav.items.assetRegister')}</h1>
      <ReportView kind="asset-register" params={PARAMS} defaults={{}} />
    </div>
  );
}
