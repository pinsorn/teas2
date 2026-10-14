'use client';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { ReportParamSpec } from '@/domain/reports';
import { ReportView } from '@/kit/report/ReportView';
import { useMe } from '@/app-shell/useMe';

const TB_PARAMS: ReportParamSpec[] = [
  { key: 'asOf', kind: 'date', labelKey: 'reports.asOf', required: true },
  { key: 'dimension', kind: 'dimension', labelKey: 'reports.dimension' },
  { key: 'includeZero', kind: 'bool', labelKey: 'reports.includeZero' },
];
const TABS = ['tb', 'pl', 'bs', 'gl'] as const; // only the trial balance is live; the rest are RP1

export function FinancialStatementsView() {
  const t = useTranslations();
  const router = useRouter();
  const search = useSearchParams();
  const { me } = useMe(); // the as-of default is the server's business date; ReportView adopts it when /me lands
  const asked = search.get('tab');
  const tab = TABS.find((x) => x === asked) ?? 'tb';
  return (
    <div className="grid gap-4">
      <h1 className="text-title font-semibold">{t('nav.items.financialStatements')}</h1>
      <Tabs value={tab} onValueChange={(v) => { const u = new URLSearchParams(search.toString()); u.set('tab', v); router.replace(`?${u}`); }}>
        <TabsList aria-label={t('reports.tabs.label')}>
          {TABS.map((x) => <TabsTrigger key={x} value={x}>{t(`reports.tabs.${x}`)}</TabsTrigger>)}
        </TabsList>
        <TabsContent value="tb"><ReportView kind="trial-balance" params={TB_PARAMS} defaults={{ asOf: me?.businessDate ?? '' }} /></TabsContent>
        {TABS.slice(1).map((x) => (
          <TabsContent key={x} value={x}>
            <div data-screen-state="coming" className="grid gap-1">
              <h2 className="text-section font-semibold">{t('shell.comingTitle')}</h2>
              <p className="text-muted-foreground">{t('shell.comingBody', { title: t(`reports.tabs.${x}`) })}</p>
            </div>
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}
