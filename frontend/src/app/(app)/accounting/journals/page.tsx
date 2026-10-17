import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import type { ReportParamSpec } from '@/domain/reports';
import { ReportView } from '@/kit/report/ReportView';

// every journal entry of the company, whatever wrote it (a document, a journal voucher, a settlement, the bank reconciliation); the server lays it out (ledger.read)
const SOURCES = ['JV', 'OB', 'TI', 'IV', 'RC', 'CN', 'DN', 'PB', 'PCN', 'PDN', 'PV', 'EX', 'STL', 'BANK', 'PP30', 'PP36'];
const PARAMS: ReportParamSpec[] = [
  { key: 'from', kind: 'date', labelKey: 'reports.gj.from' },
  { key: 'to', kind: 'date', labelKey: 'reports.gj.to' },
  { key: 'account', kind: 'account', labelKey: 'reports.gj.accountFilter' },
  { key: 'source', kind: 'select', labelKey: 'reports.gj.source', options: SOURCES.map((s) => ({ value: s, labelKey: `reports.gj.sources.${s}` })) },
];

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations())('nav.items.journals') };
}
export default async function Page() {
  const t = await getTranslations();
  return (
    <div className="grid gap-4">
      <h1 className="text-title font-semibold">{t('nav.items.journals')}</h1>
      <ReportView kind="general-journal" params={PARAMS} defaults={{}} />
    </div>
  );
}
