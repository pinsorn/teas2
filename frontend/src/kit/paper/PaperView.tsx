'use client';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { Alert, AlertTitle } from '@/components/ui/alert';
import { ApiError } from '@/lib/api/client';
import { isForbidden, useMe } from '@/app-shell/useMe';
import { Button } from '@/components/ui/button';
import type { DocType } from '@/domain/types';
import { endpoints } from '@/lib/api/endpoints';
import { qk } from '@/lib/query/keys';
import { ErrorState } from '../states/ErrorState';
import { ForbiddenState } from '../states/ForbiddenState';
import { LoadingState } from '../states/LoadingState';
import { PAPERS } from './registry';

/** Loads the server-built PaperModel and shows it. `toolbar` adds a print button (screen only) for the stand-alone print route. */
export function PaperView({ type, id, copy = false, toolbar = false }: { type: DocType; id: string; copy?: boolean; toolbar?: boolean }) {
  const t = useTranslations('docView.actions');
  const tp = useTranslations('docView.paper');
  const [ready, setReady] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const PaperComponent = PAPERS[type];

  const { me, isPending: mePending, error: meError, refetch: refetchMe } = useMe();
  const q = useQuery({ queryKey: qk.paper(me?.activeCompanyId ?? '', type, id, copy), queryFn: () => endpoints.getPaper(type, id, copy), enabled: !!me });
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const check = () => setReady(!!el.querySelector('[data-paper-ready="true"]'));
    const observer = new MutationObserver(check);
    observer.observe(el, { subtree: true, attributes: true, childList: true });
    check();
    return () => observer.disconnect();
  }, [q.data]);
  if (!PaperComponent) return <Alert role="status"><AlertTitle>{tp('notPrintable')}</AlertTitle></Alert>;
  if (meError) return <ErrorState error={meError} onRetry={() => void refetchMe()} />;
  if (mePending || q.isPending) return <LoadingState rows={3} />;
  if (q.error instanceof ApiError && q.error.code === 'doc.not_printable') return <Alert role="status"><AlertTitle>{tp('notIssued')}</AlertTitle></Alert>;
  if (q.error) return isForbidden(q.error) ? <ForbiddenState permission={`doc.${type}.read`} /> : <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  return (
    <div ref={root}>
      {toolbar ? <div className="paper-noprint flex justify-end p-3"><Button disabled={!ready} onClick={() => window.print()}>{t('print')}</Button></div> : null}
      <PaperComponent model={q.data} />
    </div>
  );
}
