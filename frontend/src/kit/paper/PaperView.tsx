'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
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
  const tpr = useTranslations('docView.print');
  const [ready, setReady] = useState(false);
  const [logFailed, setLogFailed] = useState(false);
  const [forced, setForced] = useState(false); // the server said this print is a copy although the page was opened as the original
  const asCopy = copy || forced;
  const printing = useRef(false);
  const printWhenReady = useRef(false);
  const qc = useQueryClient();
  const root = useRef<HTMLDivElement>(null);
  const PaperComponent = PAPERS[type];

  const { me, isPending: mePending, error: meError, refetch: refetchMe } = useMe();
  const q = useQuery({ queryKey: qk.paper(me?.activeCompanyId ?? '', type, id, asCopy), queryFn: () => endpoints.getPaper(type, id, asCopy), enabled: !!me });
  useEffect(() => {
    const el = root.current;
    if (!el) { setReady(false); return; } // model changed and the new one is not rendered yet: the old "ready" must not linger
    const check = () => setReady(!!el.querySelector('[data-paper-ready="true"]'));
    const observer = new MutationObserver(check);
    observer.observe(el, { subtree: true, attributes: true, childList: true });
    check();
    return () => observer.disconnect();
  }, [q.data]);
  useEffect(() => { if (ready && printWhenReady.current) { printWhenReady.current = false; window.print(); } }, [ready]); // the paper re-rendered with the server's label
  if (!PaperComponent) return <Alert role="status"><AlertTitle>{tp('notPrintable')}</AlertTitle></Alert>;
  if (meError) return <ErrorState error={meError} onRetry={() => void refetchMe()} />;
  if (mePending || q.isPending) return <LoadingState rows={3} />;
  if (q.error instanceof ApiError && q.error.code === 'doc.not_printable') return <Alert role="status"><AlertTitle>{tp('notIssued')}</AlertTitle></Alert>;
  if (q.error) return isForbidden(q.error) ? <ForbiddenState permission={`doc.${type}.read`} /> : <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  return (
    <div ref={root}>
      {toolbar ? (
        <div className="paper-noprint flex items-center justify-end gap-3 p-3">
          <h1 className="sr-only">{q.data.titleTh} {q.data.number}</h1>
          {logFailed ? <p role="status" className="text-small text-muted-foreground">{tpr('logFailed')}</p> : null}
          <Button disabled={!ready} onClick={() => {
            if (printing.current) return;
            printing.current = true; setLogFailed(false);
            // The print is logged FIRST and the server decides ต้นฉบับ / สำเนา. If it says copy while this page shows the original, the paper is re-rendered as สำเนา before anything is printed;
            // a print that could not be logged is not printed (nobody could tell whether the original is already out).
            endpoints.markPrinted(type, id, asCopy)
              .then((r) => {
                if (me) void qc.invalidateQueries({ queryKey: [me.activeCompanyId, 'doc', type, id] });
                if (r.copy && !asCopy) { printWhenReady.current = true; setForced(true); } else window.print();
              })
              .catch(() => setLogFailed(true))
              .finally(() => { printing.current = false; });
          }}>{t('print')}</Button>
        </div>
      ) : null}
      <PaperComponent model={q.data} />
    </div>
  );
}
