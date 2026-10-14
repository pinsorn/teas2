'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { useCompanyEpoch } from '@/app-shell/useCompanyEpoch';
import { isForbidden, useMe } from '@/app-shell/useMe';
import { Alert, AlertTitle } from '@/components/ui/alert';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { routesOf, type DocDescriptor } from '@/domain/descriptors';
import type { Doc, DocType } from '@/domain/types';
import { ApiError } from '@/lib/api/client';
import { endpoints } from '@/lib/api/endpoints';
import { formatDateBE, formatTHB, todayIso } from '@/lib/format';
import { qk } from '@/lib/query/keys';
import { CancelDialog } from '../dialogs/CancelDialog';
import { StatusChip } from '../doc-list/StatusChip';
import { ErrorState } from '../states/ErrorState';
import { ForbiddenState } from '../states/ForbiddenState';
import { LoadingState } from '../states/LoadingState';
import { isNotFound, NotFoundState } from '../states/NotFoundState';
import { ActionBar, type ConvertibleDescriptor } from './ActionBar';
import { ActivityTimeline } from './ActivityTimeline';
import { ChainPanel } from './ChainPanel';
import { docViewHref } from '@/descriptors';
import { LedgerTab } from './LedgerTab';
import { LockBanner, type ExitAction } from './LockBanner';
import { PAPERS } from '../paper/registry';
import { PaperView } from '../paper/PaperView';
import { RevisionHistory } from './RevisionHistory';

export interface DocViewProps { descriptor: DocDescriptor; id: string }

/** Placeholder for a revision snapshot ("ดูฉบับนี้"): paper models are served for the live document only. */
function PaperStub({ doc, revision }: { doc: Doc; revision?: number }) {
  const t = useTranslations('docView.paper');
  return (
    <div className="rounded-lg border border-dashed border-border p-6 text-body text-muted-foreground">
      {revision !== undefined ? <p className="font-medium text-foreground">{t('snapshot', { n: revision })}</p> : null}
      <p>{t(revision !== undefined ? 'stub' : 'notPrintable')}</p>
      <p className="tabular-nums">{doc.number ?? ''}</p>
    </div>
  );
}

/** Keyed by the active company: a switch drops the open tab / dialogs and re-reads the document in the new company. */
export function DocView(props: DocViewProps) {
  return <DocViewInner key={useCompanyEpoch()} {...props} />;
}

function DocViewInner({ descriptor: d, id }: DocViewProps) {
  const { me, isPending: mePending, error: meError, refetch: refetchMe } = useMe();
  const q = useQuery({
    queryKey: qk.doc(me?.activeCompanyId ?? '', d.type, id),
    queryFn: () => endpoints.getDoc(d.type, id),
    enabled: !!me,
  });
  if (meError) return <ErrorState error={meError} onRetry={() => void refetchMe()} />;
  if (mePending || q.isPending) return <LoadingState />;
  if (q.error) {
    if (isNotFound(q.error)) return <NotFoundState listHref={routesOf(d).list} />;
    return isForbidden(q.error)
      ? <ForbiddenState permission={d.permissions.read} detail={q.error instanceof ApiError ? q.error.problem.detail : undefined} />
      : <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  }
  return <Loaded d={d} doc={q.data} permissions={me!.permissions} />;
}

function Loaded({ d, doc, permissions }: { d: DocDescriptor; doc: Doc; permissions: string[] }) {
  const t = useTranslations('docView');
  const tc = useTranslations('common');
  const ts = useTranslations('state');
  const locale = useLocale();
  const router = useRouter();
  const qc = useQueryClient();
  const { me } = useMe();
  const [cancelOpen, setCancelOpen] = useState(false);
  const [notice, setNotice] = useState<string>();
  // A dead document opens on its chain: the pointer to the replacement is what the reader needs first.
  const [tab, setTab] = useState(doc.status === 'replaced' || doc.status === 'cancelled' ? 'chain' : 'paper');
  const refresh = () => qc.invalidateQueries({ queryKey: [me!.activeCompanyId] });

  const cancel = useMutation({
    mutationFn: (v: { code: string; text: string }) => endpoints.cancelDoc(d.type, doc.id, doc.version, v.code, v.text),
    onSuccess: async () => { await refresh(); setCancelOpen(false); },
    onError: (e) => { if (e instanceof ApiError && e.code === 'doc.version_conflict') void refresh(); }, // stale version: reload so a retry sends the current one
  });
  const convert = useMutation({
    mutationFn: (target: DocType) => endpoints.convertDoc(d.type, doc.id, target, doc.lines.map((l) => ({ sourceLineId: l.id, qty: l.qty }))),
    onSuccess: async (nd) => {
      await refresh();
      const href = docViewHref(nd.type, nd.id);
      if (href) router.push(href); else setNotice(t('actions.converted', { number: nd.number ?? nd.type }));
    },
  });

  // Exits are real actions. Filing / period: the same correction flow as the edit button (proposing a correction needs the create permission; the plan lists what its steps need); settlement: the chain, where the receipt is un-applied.
  const exitAction: ExitAction = (lock) => {
    if (lock.kind === 'filing' || lock.kind === 'period') {
      return { onClick: () => router.push(routesOf(d).edit(doc.id)), why: permissions.includes(d.permissions.create) ? undefined : ts('needPermission', { permission: d.permissions.create }) };
    }
    if (lock.kind === 'settlement') return { onClick: () => setTab('chain') };
    return undefined;
  };

  const title = locale === 'en' ? d.titleEn : d.titleTh;
  const label = `${doc.type} ${doc.number ?? ''}`.trim();
  const tabs = ['paper', 'chain', 'ledger', 'activity', 'revisions'] as const;
  const canLedger = permissions.includes('ledger.read'); // D-09: journals need ledger.read, not just the document's read

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
      <header className="grid gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-small text-muted-foreground">{title}</p>
          <StatusChip status={doc.status} />
          {doc.revision > 0 ? <span className="text-small text-muted-foreground">{t('header.revised', { n: doc.revision })}</span> : null}
        </div>
        <h1 className="text-h1 font-semibold tabular-nums" data-testid="doc-number">{doc.number ?? tc('draftNoNumber')}</h1>
        <dl className="grid grid-cols-[repeat(auto-fit,minmax(10rem,1fr))] gap-x-6 gap-y-2 text-body">
          <div><dt className="text-small text-muted-foreground">{t('header.party')}</dt><dd>{doc.party?.name ?? '-'}</dd></div>
          <div><dt className="text-small text-muted-foreground">{t('header.date')}</dt><dd className="tabular-nums">{formatDateBE(doc.header.documentDate)}</dd></div>
          <div><dt className="text-small text-muted-foreground">{t('header.total')}</dt><dd className="tabular-nums">{formatTHB(doc.totals.total)}</dd></div>
          {doc.outstanding !== undefined ? <div><dt className="text-small text-muted-foreground">{t('header.outstanding')}</dt><dd className="tabular-nums">{formatTHB(doc.outstanding)}</dd></div> : null}
        </dl>
        <LockBanner locks={doc.locks} exitAction={exitAction} />
      </header>

      <ActionBar descriptor={d as ConvertibleDescriptor} doc={doc} permissions={permissions} onCancel={() => { cancel.reset(); setCancelOpen(true); }} onConvert={(x) => convert.mutate(x)} />
      {notice ? <Alert role="status"><AlertTitle>{notice}</AlertTitle></Alert> : null}
      {convert.error ? <Alert variant="destructive"><AlertTitle>{convert.error instanceof ApiError ? convert.error.problem.title : tc('retry')}</AlertTitle></Alert> : null}

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="h-auto flex-wrap group-data-horizontal/tabs:h-auto">{tabs.map((k) => k === 'ledger' && !canLedger ? (
          <span key={k} title={t('ledger.needsPermission')} className="flex flex-auto">
            <TabsTrigger value={k} disabled className="h-8 flex-auto">{t(`tabs.${k}`)}<span className="sr-only"> ({t('ledger.needsPermission')})</span></TabsTrigger>
          </span>
        ) : <TabsTrigger key={k} value={k} className="h-8 flex-auto">{t(`tabs.${k}`)}</TabsTrigger>)}</TabsList>
        <TabsContent value="paper">
          <section role="region" aria-label={t('tabs.paper')} tabIndex={0} className="overflow-x-auto">
            {PAPERS[doc.type] ? <PaperView type={doc.type} id={doc.id} /> : <PaperStub doc={doc} />}
          </section>
        </TabsContent>
        <TabsContent value="chain"><ChainPanel type={d.type} id={doc.id} /></TabsContent>
        <TabsContent value="ledger"><LedgerTab type={d.type} id={doc.id} /></TabsContent>
        <TabsContent value="activity"><ActivityTimeline type={d.type} id={doc.id} /></TabsContent>
        <TabsContent value="revisions">
          <RevisionHistory type={d.type} id={doc.id} renderPaper={(snap, n) => <PaperStub doc={snap} revision={n} />} />
        </TabsContent>
      </Tabs>

      {cancelOpen ? (
        <CancelDialog docLabel={label} total={doc.totals.total} reversalDate={todayIso()} busy={cancel.isPending} error={cancel.error} hint={cancel.error instanceof ApiError && cancel.error.code === 'doc.version_conflict' ? t('cancel.stale') : undefined} onCancel={() => setCancelOpen(false)}
          onConfirm={(code, text) => cancel.mutate({ code, text })} />
      ) : null}
    </div>
  );
}
