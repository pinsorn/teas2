'use client';
import { useQuery } from '@tanstack/react-query';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useCompanyEpoch } from '@/app-shell/useCompanyEpoch';
import { useMe } from '@/app-shell/useMe';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { FilingForm } from '@/domain/filings';
import { endpoints } from '@/lib/api/endpoints';
import { qk } from '@/lib/query/keys';
import { CitYearPanel } from '@/kit/filing/CitYearPanel';
import { FilingView } from '@/kit/filing/FilingView';

const FORM: Record<'pnd50' | 'pnd51', FilingForm> = { pnd50: 'PND50', pnd51: 'PND51' };
const TABS = ['pnd50', 'pnd51'] as const;

/** TX3a: the corporate income tax for one fiscal year (`?period=YYYY`, `?tab=`): the year data and the adjustments beside the ภ.ง.ด.50 (annual) or ภ.ง.ด.51 (half-year) filing. tax.read to view; every company has it. */
export default function CitPage() {
  return <Inner key={useCompanyEpoch()} />;
}

function Inner() {
  const t = useTranslations('cit');
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const { me } = useMe();
  const companyId = me?.activeCompanyId ?? '';
  const tab = TABS.find((x) => x === search.get('tab')) ?? 'pnd50';
  // the same query FilingView runs: the year both show when ?period= is absent
  const hist = useQuery({ queryKey: qk.filings(companyId, FORM[tab]), queryFn: () => endpoints.listFilings(FORM[tab]), enabled: !!companyId });
  const year = search.get('period') || hist.data?.next || '';
  const go = (value: string) => { const u = new URLSearchParams(search.toString()); u.set('tab', value); router.replace(`${pathname}?${u}`); };
  return (
    <div className="grid gap-4">
      <h1 className="text-title font-semibold">{t('title')}</h1>
      <Tabs value={tab} onValueChange={go}>
        <TabsList aria-label={t('tabs.label')} className="h-auto flex-wrap group-data-horizontal/tabs:h-auto">
          {TABS.map((k) => <TabsTrigger key={k} value={k} className="h-8 flex-auto">{t(`tabs.${k}`)}</TabsTrigger>)}
        </TabsList>
        <TabsContent value={tab} className="grid gap-4">
          <CitYearPanel year={year} tab={tab} />
          <FilingView key={tab} form={FORM[tab]} periodKind="year" />
        </TabsContent>
      </Tabs>
    </div>
  );
}
