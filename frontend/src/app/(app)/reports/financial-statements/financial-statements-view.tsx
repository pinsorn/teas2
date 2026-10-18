'use client';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { ReportParamSpec } from '@/domain/reports';
import { ReportView } from '@/kit/report/ReportView';
import { useMe } from '@/app-shell/useMe';

const opt = (group: string, values: string[]) => values.map((value) => ({ value, labelKey: `reports.options.${group}.${value}` }));
const GROUP_BY: ReportParamSpec = { key: 'groupBy', kind: 'dimension', labelKey: 'reports.groupBy' }; // a dimension TYPE (project): one column per value
const FORMAT: ReportParamSpec = { key: 'format', kind: 'select', labelKey: 'reports.format', required: true, options: opt('format', ['class', 'dbd']) };
const TB_PARAMS: ReportParamSpec[] = [
  { key: 'asOf', kind: 'date', labelKey: 'reports.asOf', required: true },
  { key: 'dimension', kind: 'dimension', labelKey: 'reports.dimension' },
  GROUP_BY,
  { key: 'includeZero', kind: 'bool', labelKey: 'reports.includeZero' },
];
const PL_PARAMS: ReportParamSpec[] = [
  { key: 'from', kind: 'date', labelKey: 'reports.from', required: true }, { key: 'to', kind: 'date', labelKey: 'reports.to', required: true },
  { key: 'compare', kind: 'select', labelKey: 'reports.compare', required: true, options: opt('compare', ['none', 'previous', 'lastYear']) }, GROUP_BY, FORMAT,
];
const BS_PARAMS: ReportParamSpec[] = [
  { key: 'asOf', kind: 'date', labelKey: 'reports.asOf', required: true },
  { key: 'compare', kind: 'select', labelKey: 'reports.compare', required: true, options: opt('compare', ['none', 'lastYear', 'yearEnd']) }, FORMAT,
];
const GL_PARAMS: ReportParamSpec[] = [
  { key: 'account', kind: 'account', labelKey: 'reports.gj.accountFilter', required: true },
  { key: 'from', kind: 'date', labelKey: 'reports.from' }, { key: 'to', kind: 'date', labelKey: 'reports.to' },
  { key: 'party', kind: 'party', labelKey: 'reports.party' }, { key: 'dimension', kind: 'dimension', labelKey: 'reports.dimension' },
];
const TABS = ['tb', 'pl', 'bs', 'gl'] as const;

export function FinancialStatementsView() {
  const t = useTranslations();
  const router = useRouter();
  const search = useSearchParams();
  const { me } = useMe(); // the as-of default is the server's business date; ReportView adopts it when /me lands
  const asked = search.get('tab');
  const tab = TABS.find((x) => x === asked) ?? 'tb';
  const today = me?.businessDate ?? '', yearStart = today ? `${today.slice(0, 4)}-01-01` : '';
  return (
    <div className="grid gap-4">
      <h1 className="text-title font-semibold">{t('nav.items.financialStatements')}</h1>
      <Tabs value={tab} onValueChange={(v) => { const u = new URLSearchParams(search.toString()); u.set('tab', v); router.replace(`?${u}`); }}>
        <TabsList aria-label={t('reports.tabs.label')}>
          {TABS.map((x) => <TabsTrigger key={x} value={x}>{t(`reports.tabs.${x}`)}</TabsTrigger>)}
        </TabsList>
        <TabsContent value="tb"><ReportView kind="trial-balance" params={TB_PARAMS} defaults={{ asOf: today }} /></TabsContent>
        <TabsContent value="pl"><ReportView kind="profit-loss" params={PL_PARAMS} defaults={{ from: yearStart, to: today, compare: 'none', format: 'class' }} /></TabsContent>
        <TabsContent value="bs"><ReportView kind="balance-sheet" params={BS_PARAMS} defaults={{ asOf: today, compare: 'none', format: 'class' }} /></TabsContent>
        <TabsContent value="gl"><ReportView kind="general-ledger" params={GL_PARAMS} defaults={{ from: yearStart, to: today }} /></TabsContent>
      </Tabs>
    </div>
  );
}
