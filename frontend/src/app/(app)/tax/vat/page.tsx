'use client';
import { useQuery } from '@tanstack/react-query';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useCompanyEpoch } from '@/app-shell/useCompanyEpoch';
import { isForbidden, useMe } from '@/app-shell/useMe';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { ReportKind, ReportParamSpec } from '@/domain/reports';
import { ApiError } from '@/lib/api/client';
import { endpoints } from '@/lib/api/endpoints';
import { qk } from '@/lib/query/keys';
import { FilingView } from '@/kit/filing/FilingView';
import { ReportView } from '@/kit/report/ReportView';
import { ErrorState } from '@/kit/states/ErrorState';
import { ForbiddenState } from '@/kit/states/ForbiddenState';
import { LoadingState } from '@/kit/states/LoadingState';
import { NotAvailableState } from '@/kit/states/NotAvailableState';

const TABS = ['pp30', 'output', 'input'] as const;
const KIND: Record<'output' | 'input', ReportKind> = { output: 'vat-output-register', input: 'vat-input-register' };
const PARAMS: ReportParamSpec[] = [{ key: 'period', kind: 'month', labelKey: 'filing.period', required: true }];

/** TX1: the VAT filing (ภ.พ.30) and its two registers for one month (`?period=`, `?tab=`). tax.read to view; the registers are the same documents the form is made from. */
export default function VatPage() {
  return <Inner key={useCompanyEpoch()} />;
}

function Inner() {
  const t = useTranslations();
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const { me, isError: meFailed, error: meError, refetch: refetchMe } = useMe();
  const companyId = me?.activeCompanyId ?? '';
  const hist = useQuery({ queryKey: qk.filings(companyId, 'PP30'), queryFn: () => endpoints.listFilings('PP30'), enabled: !!companyId && !!me?.vatRegistered });
  const tab = TABS.find((x) => x === search.get('tab')) ?? 'pp30';
  if (meFailed && !me) return <ErrorState error={meError} onRetry={() => void refetchMe()} />;
  if (!me) return <LoadingState />;
  if (!me.vatRegistered) return <NotAvailableState reason="vatOnly" />;
  if (hist.isError && !hist.data) return isForbidden(hist.error) ? <ForbiddenState permission="tax.read" detail={hist.error instanceof ApiError ? hist.error.problem.detail : undefined} /> : <ErrorState error={hist.error} onRetry={() => void hist.refetch()} />;
  if (!hist.data) return <LoadingState />;
  const go = (value: string) => { const u = new URLSearchParams(search.toString()); u.set('tab', value); router.replace(`${pathname}?${u}`); };
  return (
    <div className="grid gap-4">
      <h1 className="text-title font-semibold">{t('nav.items.vat')}</h1>
      <Tabs value={tab} onValueChange={go}>
        <TabsList aria-label={t('filing.tabs.label')} className="h-auto flex-wrap group-data-horizontal/tabs:h-auto">
          {TABS.map((k) => <TabsTrigger key={k} value={k} className="h-8 flex-auto">{t(`filing.tabs.${k}`)}</TabsTrigger>)}
        </TabsList>
        <TabsContent value={tab}>
          {tab === 'pp30' ? <FilingView form="PP30" periodKind="month" /> : <ReportView kind={KIND[tab]} params={PARAMS} defaults={{ period: hist.data.next }} />}
        </TabsContent>
      </Tabs>
    </div>
  );
}
