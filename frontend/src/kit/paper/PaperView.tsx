'use client';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { isForbidden, useMe } from '@/app-shell/useMe';
import { Button } from '@/components/ui/button';
import type { DocType } from '@/domain/types';
import { endpoints } from '@/lib/api/endpoints';
import { qk } from '@/lib/query/keys';
import { ErrorState } from '../states/ErrorState';
import { ForbiddenState } from '../states/ForbiddenState';
import { LoadingState } from '../states/LoadingState';
import { TaxInvoicePaper } from './TaxInvoicePaper';

/** Loads the server-built PaperModel and shows it. `toolbar` adds a print button (screen only) for the stand-alone print route. */
export function PaperView({ type, id, copy = false, toolbar = false }: { type: DocType; id: string; copy?: boolean; toolbar?: boolean }) {
  const t = useTranslations('docView.actions');
  const { me, isPending: mePending, error: meError, refetch: refetchMe } = useMe();
  const q = useQuery({ queryKey: qk.paper(me?.activeCompanyId ?? '', type, id, copy), queryFn: () => endpoints.getPaper(type, id, copy), enabled: !!me });
  if (meError) return <ErrorState error={meError} onRetry={() => void refetchMe()} />;
  if (mePending || q.isPending) return <LoadingState rows={3} />;
  if (q.error) return isForbidden(q.error) ? <ForbiddenState permission={`doc.${type}.read`} /> : <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  return (
    <>
      {toolbar ? <div className="paper-noprint flex justify-end p-3"><Button onClick={() => window.print()}>{t('print')}</Button></div> : null}
      <TaxInvoicePaper model={q.data} />
    </>
  );
}
