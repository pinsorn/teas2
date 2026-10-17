'use client';
import { useQuery } from '@tanstack/react-query';
import { PrinterIcon } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useCompanyEpoch } from '@/app-shell/useCompanyEpoch';
import { isForbidden, useMe } from '@/app-shell/useMe';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { FilingForm } from '@/domain/filings';
import { ApiError } from '@/lib/api/client';
import { endpoints } from '@/lib/api/endpoints';
import { formatMoney } from '@/lib/format';
import { qk } from '@/lib/query/keys';
import { FilingView } from '@/kit/filing/FilingView';
import { EmployeeWhtCertificatePaper } from '@/kit/paper/EmployeeWhtCertificatePaper';
import { EmptyState } from '@/kit/states/EmptyState';
import { ErrorState } from '@/kit/states/ErrorState';
import { ForbiddenState } from '@/kit/states/ForbiddenState';
import { LoadingState } from '@/kit/states/LoadingState';

const RETURNS: Record<string, { form: FilingForm; kind: 'month' | 'year' }> = { pnd1: { form: 'PND1', kind: 'month' }, pnd1a: { form: 'PND1A', kind: 'year' }, sso: { form: 'SSO1-10', kind: 'month' } };
const TABS = [...Object.keys(RETURNS), 'cert'] as const;

/** PY3: the payroll returns (`?tab=`, `?period=`): ภ.ง.ด.1 and สปส.1-10 by month, ภ.ง.ด.1ก by year - each through the one FilingView of group 06 - and the annual 50 ทวิ of the employees, printed from the finalized ภ.ง.ด.1ก. Read with payroll.read; finalize is the accountant's. */
export default function PayrollFilingsPage() {
  return <Inner key={useCompanyEpoch()} />;
}

function Inner() {
  const t = useTranslations('payrollFilings');
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const tab = TABS.find((x) => x === search.get('tab')) ?? 'pnd1';
  const go = (value: string) => { const u = new URLSearchParams(search.toString()); u.set('tab', value); u.delete('period'); router.replace(`${pathname}?${u}`); };
  return (
    <div className="grid gap-4">
      <h1 className="text-title font-semibold print:hidden">{t('title')}</h1>
      <Tabs value={tab} onValueChange={go}>
        <TabsList aria-label={t('tabs.label')} className="h-auto flex-wrap group-data-horizontal/tabs:h-auto print:hidden">
          {TABS.map((k) => <TabsTrigger key={k} value={k} className="h-8 flex-auto">{t(`tabs.${k}`)}</TabsTrigger>)}
        </TabsList>
        <TabsContent value={tab}>
          {RETURNS[tab] ? <FilingView key={tab} form={RETURNS[tab].form} periodKind={RETURNS[tab].kind} /> : <Certificates />}
        </TabsContent>
      </Tabs>
    </div>
  );
}

/** Ruling 8: one 50 ทวิ per employee from the stored rows of the finalized ภ.ง.ด.1ก (the server builds every figure; this lists them and lays out the paper). */
function Certificates() {
  const t = useTranslations('payrollFilings.cert');
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const { me, isError: meFailed, error: meError, refetch: refetchMe } = useMe();
  const companyId = me?.activeCompanyId ?? '';
  const hist = useQuery({ queryKey: qk.filings(companyId, 'PND1A'), queryFn: () => endpoints.listFilings('PND1A'), enabled: !!companyId });
  const year = search.get('period') || hist.data?.items[0]?.period || hist.data?.next || '';
  const q = useQuery({ queryKey: [companyId, 'filings', 'PND1A', year, 'certificates'], queryFn: () => endpoints.employeeCertificates(year), enabled: !!companyId && !!year, retry: false });
  const pick = (value: string) => { const u = new URLSearchParams(search.toString()); if (value) u.set('period', value); else u.delete('period'); router.replace(`${pathname}?${u}`); };
  if (meFailed && !me) return <ErrorState error={meError} onRetry={() => void refetchMe()} />;
  const failed = (hist.isError && !hist.data ? hist.error : undefined) ?? (q.isError && !(q.error instanceof ApiError && q.error.problem.status === 409) ? q.error : undefined);
  if (failed) return isForbidden(failed) ? <ForbiddenState permission="payroll.read" detail={failed instanceof ApiError ? failed.problem.detail : undefined} /> : <ErrorState error={failed} onRetry={() => { void hist.refetch(); void q.refetch(); }} />;
  if (!me || !hist.data || (!!year && q.isPending)) return <LoadingState />;
  const models = q.data ?? []; // a 409 (not finalized yet) and an empty answer are both "nothing to print"
  return (
    <div className="grid gap-4" data-testid="employee-certificates">
      <div className="flex flex-wrap items-end gap-4 print:hidden">
        <div className="grid gap-1.5">
          <Label htmlFor="cert-year">{t('year')}</Label>
          <Input id="cert-year" type="number" min={2000} max={2100} step={1} value={year} onChange={(e) => pick(e.target.value)} className="w-44" />
        </div>
      </div>
      <h2 className="text-section font-semibold print:hidden">{t('title', { year: String(Number(year) + 543) })}</h2>
      {models.length === 0 ? (
        <EmptyState title={t('empty')} body={t('emptyBody')} action={<Link href={`/payroll/filings?tab=pnd1a&period=${year}`} className="text-primary underline underline-offset-2">{t('openForm')}</Link>} />
      ) : (
        <>
          <p className="text-body text-muted-foreground print:hidden">{t('lead')}</p>
          <Table aria-label={t('list')} className="print:hidden">
            <TableHeader><TableRow><TableHead>{t('name')}</TableHead><TableHead>{t('nid')}</TableHead><TableHead className="text-end">{t('income')}</TableHead><TableHead className="text-end">{t('tax')}</TableHead><TableHead className="text-end">{t('sso')}</TableHead></TableRow></TableHeader>
            <TableBody>
              {models.map((m) => (
                <TableRow key={m.number} className="h-(--row-h)" data-testid="cert-row">
                  <TableCell>{m.buyer.name}</TableCell><TableCell className="tabular-nums">{m.buyer.taxId}</TableCell>
                  <TableCell className="text-end tabular-nums">{formatMoney(m.certificate!.income)}</TableCell><TableCell className="text-end tabular-nums">{formatMoney(m.certificate!.tax)}</TableCell><TableCell className="text-end tabular-nums">{formatMoney(m.certificate!.ssoPaid ?? '0.00')}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="flex flex-wrap items-center gap-2 print:hidden">
            <Button onClick={() => window.print()}><PrinterIcon aria-hidden />{t('print')}</Button>
          </div>
          <h3 className="font-semibold print:hidden">{t('preview')}</h3>
          <div role="region" aria-label={t('preview')} tabIndex={0} data-report-region data-testid="cert-preview" className="overflow-x-auto rounded-lg border bg-card print:overflow-visible print:border-0">
            <EmployeeWhtCertificatePaper models={models} />
          </div>
        </>
      )}
    </div>
  );
}
