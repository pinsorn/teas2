'use client';
import { useQuery } from '@tanstack/react-query';
import { PrinterIcon } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useCompanyEpoch } from '@/app-shell/useCompanyEpoch';
import { isForbidden, useMe } from '@/app-shell/useMe';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { FormCatalogue } from '@/domain/reports';
import { ApiError } from '@/lib/api/client';
import { endpoints } from '@/lib/api/endpoints';
import { formatDateBE } from '@/lib/format';
import { qk } from '@/lib/query/keys';
import { monthBE } from '@/kit/close/PeriodGrid';
import { EmptyState } from '@/kit/states/EmptyState';
import { ErrorState } from '@/kit/states/ErrorState';
import { ForbiddenState } from '@/kit/states/ForbiddenState';
import { LoadingState } from '@/kit/states/LoadingState';

/** TX3b: every form of the Revenue Department with its period, due rule and last filed period, the read-only filing history across forms, and a printable rendition of ภ.พ.01 / ภ.พ.09 from the company data (`?print=PP01`, D-21: React + print CSS, no AcroForm). tax.read. */
export default function TaxFormsPage() {
  return <Inner key={useCompanyEpoch()} />;
}

const periodTh = (p: string) => (p.length === 4 ? `ปีบัญชี ${Number(p) + 543}` : monthBE(p));

function Inner() {
  const t = useTranslations('taxPage.forms');
  const { me, isError: meFailed, error: meError, refetch: refetchMe } = useMe();
  const print = useSearchParams().get('print');
  const companyId = me?.activeCompanyId ?? '';
  const q = useQuery({ queryKey: qk.formCatalogue(companyId), queryFn: endpoints.getFormCatalogue, enabled: !!companyId });
  if (meFailed && !me) return <ErrorState error={meError} onRetry={() => void refetchMe()} />;
  if (!me) return <LoadingState />;
  if (q.isError && !q.data) return isForbidden(q.error) ? <ForbiddenState permission="tax.read" detail={q.error instanceof ApiError ? q.error.problem.detail : undefined} /> : <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  if (!q.data) return <LoadingState />;
  const c = q.data;
  if (!c.forms.length) return <div className="grid gap-4"><h1 className="text-title font-semibold">{t('title')}</h1><EmptyState title={t('history.empty')} /></div>;
  if ((print === 'PP01' || print === 'PP09') && c.forms.some((f) => f.form === print)) return <Paper form={print} company={c.company} />;
  return (
    <div className="grid gap-6">
      <h1 className="text-title font-semibold">{t('title')}</h1>
      <section aria-label={t('catalogue')} className="grid gap-2" data-testid="form-catalogue">
        <h2 className="text-section font-semibold">{t('catalogue')}</h2>
        <Table aria-label={t('catalogue')}>
          <TableHeader><TableRow><TableHead>{t('form')}</TableHead><TableHead>{t('periodKind')}</TableHead><TableHead>{t('due')}</TableHead><TableHead>{t('last')}</TableHead><TableHead /></TableRow></TableHeader>
          <TableBody>
            {c.forms.map((f) => (
              <TableRow key={f.form} className="h-(--row-h)" data-testid={`form-${f.form}`}>
                <TableCell className="font-medium whitespace-normal">{f.nameTh}</TableCell>
                <TableCell>{t(`kinds.${f.periodKind}`)}</TableCell>
                <TableCell className="whitespace-normal">{f.dueRuleTh}</TableCell>
                <TableCell>{f.lastFinalized ? periodTh(f.lastFinalized) : <span className="text-muted-foreground">{t('none')}</span>}</TableCell>
                <TableCell className="text-end">
                  {f.printable
                    ? <Button asChild size="sm" variant="outline"><Link href={f.href}><PrinterIcon aria-hidden />{t('print')}</Link></Button>
                    : <Button asChild size="sm" variant="outline"><Link href={f.href} aria-label={`${t('open')} ${f.nameTh}`}>{t('open')}</Link></Button>}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </section>
      <History rows={c.history} />
    </div>
  );
}

function History({ rows }: { rows: FormCatalogue['history'] }) {
  const t = useTranslations('taxPage.forms.history'), tf = useTranslations('taxPage.forms');
  return (
    <section aria-label={t('title')} className="grid gap-2" data-testid="all-filing-history">
      <h2 className="text-section font-semibold">{t('title')}</h2>
      {rows.length === 0 ? <EmptyState title={t('empty')} /> : (
        <Table aria-label={t('title')}>
          <TableHeader><TableRow><TableHead>{tf('form')}</TableHead><TableHead>{t('period')}</TableHead><TableHead>{t('at')}</TableHead><TableHead>{t('by')}</TableHead><TableHead>{t('files')}</TableHead></TableRow></TableHeader>
          <TableBody>
            {rows.map((h) => (
              <TableRow key={`${h.form}-${h.period}`} className="h-(--row-h)">
                <TableCell>{h.nameTh.split(' ')[0]}</TableCell>
                <TableCell><Link href={h.href} className="text-primary underline underline-offset-2">{periodTh(h.period)}</Link></TableCell>
                <TableCell>{formatDateBE(h.finalizedAt.slice(0, 10))}</TableCell>
                <TableCell>{h.finalizedBy}</TableCell>
                <TableCell><span className="flex gap-3">
                  {h.exports.map((e) => <a key={e} className="text-primary underline underline-offset-2" href={e === 'pdf' ? h.href : `/bff/v1/filings/${h.form}/${h.period}/export`} {...(e === 'rdprep-txt' ? { download: `${h.form}-${h.period}.txt` } : {})}>{e === 'pdf' ? t('pdf') : t('rdprep')}</a>)}</span>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}

/** ภ.พ.01 / ภ.พ.09 as a sheet of paper pre-filled from the company record. */
function Paper({ form, company }: { form: 'PP01' | 'PP09'; company: FormCatalogue['company'] }) {
  const t = useTranslations('taxPage.forms.paper');
  const rows: [string, string][] = [[t('name'), company.legalNameTh], [t('tin'), company.taxId], [t('branch'), company.branchCode], [t('address'), company.address]];
  return (
    <div data-report-region data-testid={`paper-${form}`} className="mx-auto grid max-w-2xl gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2 print:hidden">
        <Button asChild variant="outline" size="sm"><Link href="/tax/forms">{t('back')}</Link></Button>
        <Button size="sm" onClick={() => window.print()}><PrinterIcon aria-hidden />{t('printNow')}</Button>
      </div>
      <p className="text-small text-muted-foreground print:hidden">{t('note')}</p>
      <article className="grid gap-4 rounded-md border bg-background p-6 print:border-0 print:p-0">
        <h1 className="text-center text-title font-semibold">{t(form === 'PP01' ? 'pp01' : 'pp09')}</h1>
        <dl className="grid gap-2">
          {rows.map(([k, v]) => <div key={k} className="grid grid-cols-[8rem_1fr] gap-2 border-b py-1"><dt className="text-muted-foreground">{k}</dt><dd className="break-words tabular-nums">{v}</dd></div>)}
        </dl>
        <p>{form === 'PP01' ? t('reason') : t('changes')}</p>
        {form === 'PP09' ? <div className="h-24 rounded border border-dashed" aria-hidden /> : null}
        <div className="mt-8 grid gap-1 justify-self-end text-center">
          <div className="w-64 border-b pt-8" aria-hidden />
          <p>{t('sign')}</p>
          <p>{t('date')} ........................</p>
        </div>
      </article>
    </div>
  );
}
