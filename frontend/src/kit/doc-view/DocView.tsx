'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { useCompanyEpoch } from '@/app-shell/useCompanyEpoch';
import { isForbidden, useMe } from '@/app-shell/useMe';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { routesOf, type DocDescriptor } from '@/domain/descriptors';
import type { Doc, MarkKey } from '@/domain/types';
import { ApiError } from '@/lib/api/client';
import { endpoints } from '@/lib/api/endpoints';
import { formatDateBE, formatTHB } from '@/lib/format';
import { qk } from '@/lib/query/keys';
import { CancelDialog } from '../dialogs/CancelDialog';
import { StatusChip } from '../doc-list/StatusChip';
import { ErrorState } from '../states/ErrorState';
import { ForbiddenState } from '../states/ForbiddenState';
import { LoadingState } from '../states/LoadingState';
import { isNotFound, NotFoundState } from '../states/NotFoundState';
import { ActionBar, type ConvertibleDescriptor } from './ActionBar';
import { ActivityTimeline } from './ActivityTimeline';
import { AgentBanner } from './AgentBanner';
import { AttachmentsPanel } from './AttachmentsPanel';
import { ReprintDialog } from './ReprintDialog';
import { ChainPanel } from './ChainPanel';
import { ConvertDialog } from './ConvertDialog';
import { DocLinesPreview } from './DocLinesPreview';
import { CloseRemainderDialog } from '../dialogs/CloseRemainderDialog';
import { MarkDialog } from './MarkDialog';
import { MarksChips } from './MarksChips';
import { docEditHref, docViewHref } from '@/descriptors';
import { CLOSEABLE, LIVE } from '@/domain/doc-types';
import { LedgerTab } from './LedgerTab';
import { ObSummary } from '../opening/ObSummary';
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
  const tst = useTranslations('status');
  const ts = useTranslations('state');
  const locale = useLocale();
  const router = useRouter();
  const qc = useQueryClient();
  const { me } = useMe();
  const [cancelOpen, setCancelOpen] = useState(false);
  const [convertOpen, setConvertOpen] = useState(false);
  const [markOpen, setMarkOpen] = useState<MarkKey>();
  const [closeOpen, setCloseOpen] = useState(false);
  const [reprintOpen, setReprintOpen] = useState(false);
  const [notice, setNotice] = useState<string>();
  // A dead document opens on its chain: the pointer to the replacement is what the reader needs first.
  // A type with no paper (a vendor's document is recorded, not printed) opens on its chain as well.
  const [tab, setTab] = useState(doc.status === 'replaced' || doc.status === 'cancelled' || (!PAPERS[doc.type] && doc.type !== 'OB') ? 'chain' : 'paper');
  const refresh = () => qc.invalidateQueries({ queryKey: [me!.activeCompanyId] });

  const cancel = useMutation({
    mutationFn: (v: { code: string; text: string }) => endpoints.cancelDoc(d.type, doc.id, doc.version, v.code, v.text),
    onSuccess: async () => { await refresh(); setCancelOpen(false); },
    onError: (e) => { if (e instanceof ApiError && e.code === 'doc.version_conflict') void refresh(); }, // stale version: reload so a retry sends the current one
  });
  const mark = useMutation({
    mutationFn: (v: { mark: MarkKey; reason?: string }) => endpoints.setMark(d.type, doc.id, v.mark, doc.version, v.reason),
    onSuccess: async () => { await refresh(); setMarkOpen(undefined); },
    onError: (e) => { if (e instanceof ApiError && e.code === 'doc.version_conflict') void refresh(); },
  });
  const closeable = CLOSEABLE.includes(d.type) && LIVE.includes(doc.status) && !doc.marks?.closed;
  const rem = useQuery({ queryKey: qk.remaining(me!.activeCompanyId, d.type, doc.id), queryFn: () => endpoints.getRemaining(d.type, doc.id), enabled: closeable });
  const close = useMutation({
    mutationFn: (reason: string) => endpoints.closeRemainder(d.type, doc.id, doc.version, reason),
    onSuccess: async () => { await refresh(); setCloseOpen(false); },
    onError: (e) => { if (e instanceof ApiError && e.code === 'doc.version_conflict') void refresh(); },
  });
  // A conversion lands on the new draft's edit screen (a type whose screens are not built yet still has its route).
  const converted = (nd: Doc) => {
    setConvertOpen(false);
    const href = docEditHref(nd.type, nd.id) ?? docViewHref(nd.type, nd.id);
    if (href) router.push(href); else setNotice(t('actions.converted', { number: nd.number ?? nd.type }));
  };

  // Exits are real actions. Filing / period: the same correction flow as the edit button (proposing a correction needs the create permission; the plan lists what its steps need); settlement: the chain, where the receipt is un-applied.
  const exitAction: ExitAction = (lock, exit) => {
    if (lock.kind === 'period' && exit !== lock.exits[0]) return undefined; // the reopen exit is plain text until AC6 builds period reopen
    if (lock.kind === 'filing' || lock.kind === 'period') {
      return { onClick: () => router.push(routesOf(d).edit(doc.id)), why: permissions.includes(d.permissions.create) ? undefined : ts('needPermission', { permission: d.permissions.create }) };
    }
    if (lock.kind === 'settlement') return lock.href ? { onClick: () => router.push(lock.href!) } : { onClick: () => setTab('chain') }; // FN3: a lock from a settlement record leads to it (reverse it there); a receipt's goes to the chain
    if (lock.kind === 'reversal' && lock.exits.length) return { onClick: () => setTab('ledger') }; // a reversal JV: the กลับรายการ action is on its ledger tab
    if (lock.kind === 'reconciliation' && lock.href) return { onClick: () => router.push(lock.href!) }; // the bank line, where the match is cancelled
    return undefined;
  };

  const title = locale === 'en' ? d.titleEn : d.titleTh;
  const label = `${doc.type} ${doc.number ?? ''}`.trim();
  const tabs = ['paper', 'chain', 'ledger', 'activity', 'attachments', 'revisions'] as const;
  const canLedger = permissions.includes('ledger.read'); // D-09: journals need ledger.read, not just the document's read

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
      <header className="grid gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-small text-muted-foreground">{title}</p>
          <StatusChip status={doc.status} />
          <MarksChips marks={doc.marks} />
          {doc.revision > 0 ? <span className="text-small text-muted-foreground">{t('header.revised', { n: doc.revision })}</span> : null}
          {doc.header.inputVatForfeited ? <Badge variant="outline" data-testid="input-vat-forfeited">{t('header.inputVatForfeited')}</Badge> : null}
          {doc.header.complete === false ? <Badge variant="outline" data-testid="doc-incomplete">{t('header.incomplete')}</Badge> : null}
        </div>
        <h1 className="text-h1 font-semibold tabular-nums" data-testid="doc-number">{doc.number ?? (doc.status === 'pending' || doc.status === 'approved' ? tst(doc.status) : tc('draftNoNumber'))}</h1>
        <dl className="grid grid-cols-[repeat(auto-fit,minmax(10rem,1fr))] gap-x-6 gap-y-2 text-body">
          {d.type === 'JV' && !doc.lines.some((l) => l.partyId) ? null : <div><dt className="text-small text-muted-foreground">{t(d.partyKind === 'employee' ? 'header.employee' : 'header.party')}</dt><dd>{doc.party?.name ?? '-'}</dd></div>}
          <div><dt className="text-small text-muted-foreground">{t('header.date')}</dt><dd className="tabular-nums">{formatDateBE(doc.header.documentDate)}</dd></div>
          <div><dt className="text-small text-muted-foreground">{t('header.total')}</dt><dd className="tabular-nums">{formatTHB(doc.totals.total)}</dd></div>
          {doc.header.vendorDocNumber ? <div><dt className="text-small text-muted-foreground">{t('header.vendorDoc')}</dt><dd className="tabular-nums">{doc.header.vendorDocNumber}</dd></div> : null}
          {doc.header.vendorDocDate ? <div><dt className="text-small text-muted-foreground">{t('header.vendorDocDate')}</dt><dd className="tabular-nums">{formatDateBE(doc.header.vendorDocDate)}</dd></div> : null}
          {(doc.header.claimPeriod ?? (doc.type === 'PCN' && doc.status !== 'draft' ? doc.header.documentDate.slice(0, 7) : undefined)) && me?.vatRegistered ? <div><dt className="text-small text-muted-foreground">{t('header.claimPeriod')}</dt><dd className="tabular-nums" data-testid="claim-period">{doc.header.claimPeriod ?? doc.header.documentDate.slice(0, 7)}</dd></div> : null}
          {doc.progress ? <div><dt className="text-small text-muted-foreground">{t('header.progress')}</dt><dd className="tabular-nums">{doc.progress}</dd></div> : null}
          {doc.outstanding !== undefined ? <div><dt className="text-small text-muted-foreground">{t('header.outstanding')}</dt><dd className="tabular-nums">{formatTHB(doc.outstanding)}</dd></div> : null}
        </dl>
        <LockBanner locks={doc.locks} exitAction={exitAction} />
        <AgentBanner actor={doc.createdBy} status={doc.status} reportId={doc.agentReportId} />
      </header>

      <ActionBar descriptor={d as ConvertibleDescriptor} doc={doc} permissions={permissions} vatRegistered={me!.vatRegistered} companyId={me!.activeCompanyId} onCancel={() => { cancel.reset(); setCancelOpen(true); }} onConvert={() => setConvertOpen(true)}
        onReprint={() => setReprintOpen(true)} onMark={(m) => { mark.reset(); setMarkOpen(m); }} onCloseRemainder={() => { close.reset(); setCloseOpen(true); }}
        nothingRemaining={closeable && !!rem.data && rem.data.every((l) => l.remaining === '0')} />
      {doc.marks?.closed ? (
        <Alert role="status"><AlertTitle>{t('closedAlert')}</AlertTitle><AlertDescription>{t('marks.rejectedWhy', { reason: doc.marks.closed.reason })}</AlertDescription></Alert>
      ) : null}
      {d.type === 'QT' && doc.marks?.rejected ? (
        <Alert role="status"><AlertTitle>{t('rejectedQt')}</AlertTitle><AlertDescription>{t('marks.rejectedWhy', { reason: doc.marks.rejected.reason })}</AlertDescription></Alert>
      ) : null}
      {notice ? <Alert role="status"><AlertTitle>{notice}</AlertTitle></Alert> : null}

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="h-auto flex-wrap group-data-horizontal/tabs:h-auto">{tabs.map((k) => k === 'ledger' && !canLedger ? (
          <span key={k} title={t('ledger.needsPermission')} className="flex flex-auto">
            <TabsTrigger value={k} disabled className="h-8 flex-auto">{t(`tabs.${k}`)}<span className="sr-only"> ({t('ledger.needsPermission')})</span></TabsTrigger>
          </span>
        ) : <TabsTrigger key={k} value={k} className="h-8 flex-auto">{t(`tabs.${k}`)}</TabsTrigger>)}</TabsList>
        <TabsContent value="paper">
          <section role="region" aria-label={t('tabs.paper')} tabIndex={0} className="overflow-x-auto">
            {doc.type === 'OB' ? <ObSummary doc={doc} /> : doc.status === 'pending' || doc.status === 'approved' ? <DocLinesPreview doc={doc} /> : PAPERS[doc.type] ? <PaperView type={doc.type} id={doc.id} /> : <PaperStub doc={doc} />}
          </section>
        </TabsContent>
        <TabsContent value="chain"><ChainPanel type={d.type} id={doc.id} /></TabsContent>
        <TabsContent value="ledger"><LedgerTab type={d.type} id={doc.id} /></TabsContent>
        <TabsContent value="activity"><ActivityTimeline type={d.type} id={doc.id} /></TabsContent>
        <TabsContent value="attachments">
          <AttachmentsPanel type={d.type} docId={doc.id} canEdit={permissions.includes(d.permissions.create)} issued={doc.status !== 'draft'} />
        </TabsContent>
        <TabsContent value="revisions">
          <RevisionHistory type={d.type} id={doc.id} renderPaper={(snap, n) => <PaperStub doc={snap} revision={n} />} />
        </TabsContent>
      </Tabs>

      {reprintOpen ? <ReprintDialog docLabel={label} onCancel={() => setReprintOpen(false)} onConfirm={() => router.push(`${routesOf(d).print(doc.id)}?copy=1`)} /> : null}
      {convertOpen ? <ConvertDialog source={doc} targets={d.convertsTo ?? []} onDone={converted} onClose={() => setConvertOpen(false)} /> : null}
      {markOpen === 'accepted' || markOpen === 'rejected' || markOpen === 'delivered' || markOpen === 'sent' ? (
        <MarkDialog mark={markOpen} docLabel={label} busy={mark.isPending} error={mark.error} onCancel={() => setMarkOpen(undefined)}
          onConfirm={(reason) => mark.mutate({ mark: markOpen, reason })} />
      ) : null}
      {closeOpen ? <CloseRemainderDialog docLabel={label} busy={close.isPending} error={close.error} onCancel={() => setCloseOpen(false)} onConfirm={(r) => close.mutate(r)} /> : null}
      {cancelOpen ? (
        <CancelDialog docLabel={label} total={doc.totals.total} busy={cancel.isPending} error={cancel.error} hint={cancel.error instanceof ApiError && cancel.error.code === 'doc.version_conflict' ? t('cancel.stale') : undefined} onCancel={() => setCancelOpen(false)}
          onConfirm={(code, text) => cancel.mutate({ code, text })} />
      ) : null}
    </div>
  );
}
