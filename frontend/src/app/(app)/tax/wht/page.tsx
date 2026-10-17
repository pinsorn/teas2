'use client';
import { useQuery } from '@tanstack/react-query';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useCompanyEpoch } from '@/app-shell/useCompanyEpoch';
import { useMe } from '@/app-shell/useMe';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { FilingForm } from '@/domain/filings';
import type { ReportParamSpec } from '@/domain/reports';
import { endpoints } from '@/lib/api/endpoints';
import { qk } from '@/lib/query/keys';
import { FilingView } from '@/kit/filing/FilingView';
import { ReportView } from '@/kit/report/ReportView';

const RETURNS: Record<string, FilingForm> = { pnd3: 'PND3', pnd53: 'PND53', pnd2: 'PND2', pnd54: 'PND54', pp36: 'PP36' };
const TABS = [...Object.keys(RETURNS), 'withheld', 'missing'] as const;
const WITHHELD: ReportParamSpec[] = [{ key: 'asOf', kind: 'date', labelKey: 'reports.asOf' }];

/** TX2b: the withholding returns (ภ.ง.ด.3 / 53 / 2 / 54), the ภ.พ.36, the tax customers withheld from us and the chase list of missing 50 ทวิ (`?tab=`, `?period=`). tax.read to view; every company has it (not VAT-gated). */
export default function WhtPage() {
  return <Inner key={useCompanyEpoch()} />;
}

function Inner() {
  const t = useTranslations();
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const { me } = useMe();
  const companyId = me?.activeCompanyId ?? '';
  // the same query (key, params) the chase-list tab runs: the badge costs nothing extra once that tab is open
  const missing = useQuery({ queryKey: qk.report(companyId, 'missing-wht-cert', {}), queryFn: () => endpoints.getReport('missing-wht-cert', {}), enabled: !!companyId });
  const count = missing.data?.rows.length ?? 0;
  const tab = TABS.find((x) => x === search.get('tab')) ?? 'pnd3';
  const go = (value: string) => { const u = new URLSearchParams(search.toString()); u.set('tab', value); u.delete('period'); router.replace(`${pathname}?${u}`); };
  return (
    <div className="grid gap-4">
      <h1 className="text-title font-semibold">{t('wht.title')}</h1>
      <Tabs value={tab} onValueChange={go}>
        <TabsList aria-label={t('wht.tabs.label')} className="h-auto flex-wrap group-data-horizontal/tabs:h-auto">
          {TABS.map((k) => (
            <TabsTrigger key={k} value={k} className="h-8 flex-auto">
              {t(`wht.tabs.${k}`)}
              {k === 'missing' && count ? <span className="ms-1.5 rounded-full bg-(--color-status-pending-bg) px-1.5 text-small tabular-nums text-(--color-status-pending-fg)" aria-label={t('wht.missingCount', { n: count })} data-testid="missing-badge">{count}</span> : null}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value={tab}>
          {RETURNS[tab] ? <FilingView key={tab} form={RETURNS[tab]} periodKind="month" />
            : tab === 'withheld' ? <ReportView kind="wht-receivable" params={WITHHELD} defaults={{ asOf: '' }} />
            : <ReportView kind="missing-wht-cert" params={[]} defaults={{}} />}
        </TabsContent>
      </Tabs>
    </div>
  );
}
