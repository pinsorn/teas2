'use client';
import { useQuery } from '@tanstack/react-query';
import { DownloadIcon, PrinterIcon } from 'lucide-react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useCompanyEpoch } from '@/app-shell/useCompanyEpoch';
import { useMe } from '@/app-shell/useMe';
import { Button } from '@/components/ui/button';
import type { ReportKind, ReportParamSpec } from '@/domain/reports';
import { ApiError } from '@/lib/api/client';
import { endpoints } from '@/lib/api/endpoints';
import { formatDateBE, formatMoney } from '@/lib/format';
import { qk } from '@/lib/query/keys';
import { EmptyState } from '../states/EmptyState';
import { ErrorState } from '../states/ErrorState';
import { ForbiddenState } from '../states/ForbiddenState';
import { LoadingState } from '../states/LoadingState';
import { ReportParams } from './ReportParams';
import { ReportTable } from './ReportTable';
import { TieOutBanner } from './TieOutBanner';

export interface ReportViewProps { kind: ReportKind; params: ReportParamSpec[]; defaults: Record<string, string>; exportable?: boolean }
const DEBOUNCE_MS = 300;
const same = (a: Record<string, string>, b: Record<string, string>) => JSON.stringify(a) === JSON.stringify(b);

/** A server-computed report: parameters in the URL (applied 300 ms after the last change), states by cause, tie-out banner. Remounts on a company switch. */
export function ReportView(p: ReportViewProps) {
  return <Inner key={useCompanyEpoch()} {...p} />;
}

function Inner({ kind, params: specs, defaults, exportable = true }: ReportViewProps) {
  const t = useTranslations();
  const dyn = t as unknown as (key: string, v: Record<string, string>) => string; // server-supplied label keys are not statically known
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const { me, isError: meFailed, error: meError, refetch: refetchMe } = useMe();

  const fromUrl = Object.fromEntries(specs.map((s) => [s.key, search.has(s.key) ? search.get(s.key) ?? '' : defaults[s.key] ?? '']));
  const [vals, setVals] = useState(fromUrl);       // what the inputs show
  const [applied, setApplied] = useState(fromUrl); // what the query uses (debounced)
  const [seen, setSeen] = useState(JSON.stringify(fromUrl));
  // The URL changed from outside (back / forward, a link): adopt it at once. Our own replace echoes back as the already-applied values.
  if (seen !== JSON.stringify(fromUrl)) {
    setSeen(JSON.stringify(fromUrl));
    if (!same(fromUrl, applied)) { setVals(fromUrl); setApplied(fromUrl); }
  }
  const latest = useRef(search); // the debounced write merges into the URL as it is THEN (a tab change within 300 ms survives)
  useEffect(() => { latest.current = search; });
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const change = (key: string, value: string) => {
    const next = { ...vals, [key]: value };
    setVals(next);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      setApplied(next);
      const u = new URLSearchParams(latest.current.toString());
      // an empty value stays in the URL when the key has a default: absent = use the default, present-and-empty = the user cleared it
      for (const [k, v] of Object.entries(next)) if (v || defaults[k]) u.set(k, v); else u.delete(k);
      router.replace(`${pathname}?${u}`);
    }, DEBOUNCE_MS);
  };

  const companyId = me?.activeCompanyId ?? '';
  const missing = specs.some((s) => s.required && !applied[s.key]);
  const q = useQuery({
    queryKey: qk.report(companyId, kind, applied),
    enabled: !!companyId && !missing,
    placeholderData: (prev, prevQuery) => (prevQuery?.queryKey[0] === companyId ? prev : undefined), // never another company's rows
    queryFn: () => endpoints.getReport(kind, applied),
  });

  const exportCsv = async () => {
    try {
      const url = URL.createObjectURL(await endpoints.exportReport(kind, applied));
      const a = document.createElement('a');
      a.href = url; a.download = `${kind}.csv`;
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000); // after the browser has started the download
    } catch { toast.error(t('reports.exportFailed')); }
  };

  if (meFailed && !me) return <ErrorState error={meError} onRetry={() => void refetchMe()} />;
  if (!me) return <LoadingState />;

  let body;
  if (missing) body = <p className="text-muted-foreground">{t('reports.needParams')}</p>;
  else if (q.isError && !q.data) {
    const e = q.error;
    body = e instanceof ApiError && e.problem.status === 403
      ? <ForbiddenState detail={e.problem.detail} permission="report.read" />
      : <ErrorState error={e} onRetry={() => void q.refetch()} />;
  } else if (!q.data) body = <LoadingState />;
  else {
    const m = q.data;
    const ok = m.rows.length ? m.tieOuts?.filter((o) => o.diff === '0.00') ?? [] : [];
    body = (
      <div className="grid gap-3">
        <TieOutBanner tieOuts={m.tieOuts ?? []} />
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-section font-semibold">{t(m.titleKey as never)}{m.asOf ? ` ${t('reports.asOf')} ${formatDateBE(m.asOf)}` : ''}</h2>
          {exportable ? (
            <div className="flex gap-2 print:hidden">
              <Button variant="outline" size="sm" onClick={() => void exportCsv()}><DownloadIcon aria-hidden />{t('reports.exportCsv')}</Button>
              <Button variant="outline" size="sm" onClick={() => window.print()}><PrinterIcon aria-hidden />{t('reports.print')}</Button>
            </div>
          ) : null}
        </div>
        {m.rows.length ? <ReportTable title={t(m.titleKey as never)} columns={m.columns} rows={m.rows} /> : <EmptyState title={t('reports.empty')} />}
        {ok.map((o) => (
          <p key={o.labelKey} className="text-small text-muted-foreground tabular-nums">
            {t('reports.tieOut.ok')}: {dyn(o.labelKey, { left: formatMoney(o.left), right: formatMoney(o.right) })}
          </p>
        ))}
        {m.notes?.map((n) => <p key={n} className="text-small text-muted-foreground">{n}</p>)}
      </div>
    );
  }
  return (
    <div data-report-region className="grid gap-4">
      <ReportParams specs={specs} values={vals} onChange={change} />
      {body}
    </div>
  );
}
