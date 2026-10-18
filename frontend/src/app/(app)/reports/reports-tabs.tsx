'use client';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useMe } from '@/app-shell/useMe';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { ReportKind, ReportParamSpec } from '@/domain/reports';
import { ReportView } from '@/kit/report/ReportView';

/** A tab of a report page. A default of `@today` / `@yearStart` is the server's business date (from /me) or the start of its year. */
interface ReportTab { key: string; kind: ReportKind; params: ReportParamSpec[]; defaults?: Record<string, string> }
const opt = (group: string, values: string[]) => values.map((value) => ({ value, labelKey: `reports.options.${group}.${value}` }));

const asOf: ReportParamSpec = { key: 'asOf', kind: 'date', labelKey: 'reports.asOf', required: true };
const from: ReportParamSpec = { key: 'from', kind: 'date', labelKey: 'reports.from', required: true };
const to: ReportParamSpec = { key: 'to', kind: 'date', labelKey: 'reports.to', required: true };
const basis: ReportParamSpec = { key: 'basis', kind: 'select', labelKey: 'reports.basis', required: true, options: opt('basis', ['due', 'document']) };
const party = (partyKind: 'customer' | 'vendor'): ReportParamSpec => ({ key: 'party', kind: 'party', labelKey: `reports.${partyKind}`, required: true, partyKind });
const groupBy = (values: string[]): ReportParamSpec => ({ key: 'groupBy', kind: 'select', labelKey: 'reports.summary.groupBy', required: true, options: opt('groupBy', values) });
const dimension: ReportParamSpec = { key: 'dimension', kind: 'dimension', labelKey: 'reports.dimensionType' };
const range = { from: '@yearStart', to: '@today' };

/** The two report pages of RP2: aging and statements (report.arap.read) and the sales / purchase summaries, outstanding POs and the asset register. The server computes every figure and its tie-out to the ledger. */
const PAGES = {
  arap: {
    title: 'nav.items.receivablesPayables', label: 'reports.tabs.labelArap',
    tabs: [
      { key: 'ar', kind: 'ar-aging', params: [asOf, basis], defaults: { asOf: '@today', basis: 'due' } },
      { key: 'ap', kind: 'ap-aging', params: [asOf, basis], defaults: { asOf: '@today', basis: 'due' } },
      { key: 'cs', kind: 'customer-statement', params: [party('customer'), from, to], defaults: range },
      { key: 'vl', kind: 'vendor-ledger', params: [party('vendor'), from, to], defaults: range },
    ] as ReportTab[],
  },
  sp: {
    title: 'nav.items.salesPurchases', label: 'reports.tabs.labelSp',
    tabs: [
      { key: 'sales', kind: 'sales-summary', params: [from, to, groupBy(['customer', 'item', 'dimension', 'month']), dimension], defaults: { ...range, groupBy: 'customer' } },
      { key: 'purchases', kind: 'purchase-summary', params: [from, to, groupBy(['vendor', 'item', 'dimension', 'month']), dimension], defaults: { ...range, groupBy: 'vendor' } },
      { key: 'po', kind: 'outstanding-po', params: [asOf, { key: 'overdueOnly', kind: 'bool', labelKey: 'reports.overdueOnly' }], defaults: { asOf: '@today' } },
      { key: 'assets', kind: 'asset-register', params: [{ key: 'asOf', kind: 'date', labelKey: 'reports.asOf' }], defaults: {} },
    ] as ReportTab[],
  },
};

export function ReportTabs({ page }: { page: keyof typeof PAGES }) {
  const t = useTranslations();
  const router = useRouter();
  const search = useSearchParams();
  const { me } = useMe(); // the date defaults are the server's business date; ReportView adopts them when /me lands
  const today = me?.businessDate ?? '', yearStart = today ? `${today.slice(0, 4)}-01-01` : '';
  const { title, label, tabs } = PAGES[page];
  const tab = tabs.find((x) => x.key === search.get('tab')) ?? tabs[0];
  const fill = (d: Record<string, string> = {}) => Object.fromEntries(Object.entries(d).map(([k, v]) => [k, v === '@today' ? today : v === '@yearStart' ? yearStart : v]));
  return (
    <div className="grid gap-4">
      <h1 className="text-title font-semibold">{t(title as never)}</h1>
      <Tabs value={tab.key} onValueChange={(v) => { const u = new URLSearchParams(search.toString()); u.set('tab', v); router.replace(`?${u}`); }}>
        <TabsList aria-label={t(label as never)} className="h-auto max-w-full flex-wrap justify-start">
          {tabs.map((x) => <TabsTrigger key={x.key} value={x.key}>{t(`reports.tabs.${x.key}` as never)}</TabsTrigger>)}
        </TabsList>
        {tabs.map((x) => <TabsContent key={x.key} value={x.key}><ReportView kind={x.kind} params={x.params} defaults={fill(x.defaults)} /></TabsContent>)}
      </Tabs>
    </div>
  );
}
