'use client';
import { useQueryClient } from '@tanstack/react-query';
import { EyeIcon, ListTreeIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useId, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react';
import { useMe } from '@/app-shell/useMe';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { routesOf, type DocDescriptor } from '@/domain/descriptors';
import type { Doc, DocHeader, DocLine, ItemSummary, PartySummary } from '@/domain/types';
import { ApiError } from '@/lib/api/client';
import { endpoints, type DocInput } from '@/lib/api/endpoints';
import { formatDateBE } from '@/lib/format';
import { cn } from '@/lib/utils';
import { ConfirmIssueDialog } from '../dialogs/ConfirmIssueDialog';
import { StatusChip } from '../doc-list/StatusChip';
import { JournalDrawer } from './JournalDrawer';
import { isBlankLine, LineGrid, newLine } from './LineGrid';
import { MissingSummary } from './MissingSummary';
import { PartyField } from './PartyField';
import { PreviewDrawer } from './PreviewDrawer';
import { TotalsPanel } from './TotalsPanel';
import { useAutosave } from './useAutosave';
import { useCompute } from './useCompute';
import { isComposing, moneyText, qtyText } from './useLineGridKeys';

export interface DocEditorProps {
  descriptor: DocDescriptor;
  mode: 'create' | 'edit-draft' | 'revise';
  initial?: Doc;
  onIssued: (doc: Doc) => void;
  onRevisionRequested?: (proposed: { header: DocHeader; lines: DocLine[] }) => void; // revise mode: hands off to the correction plan
}

const WIDE = '(min-width: 1700px)';
const useWide = () => useSyncExternalStore(
  (cb) => {
    const mq = window.matchMedia?.(WIDE);
    mq?.addEventListener('change', cb);
    return () => mq?.removeEventListener('change', cb);
  },
  () => window.matchMedia?.(WIDE).matches ?? false,
  () => false,
);

const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
/** Calendar-date arithmetic for the payment-terms due date (not money, not tax). */
const addDays = (iso: string, n: number) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
const searchItems = (q: string) => endpoints.searchItems({ q, limit: 8 }).then((p) => p.items);
async function itemById(id: string): Promise<ItemSummary | undefined> {
  const hit = (await endpoints.searchItems({ q: id, limit: 5 })).items.find((i) => i.id === id);
  return hit ?? (await endpoints.searchItems({ limit: 200 })).items.find((i) => i.id === id);
}

function ProblemBanner({ error, hint, action }: { error: unknown; hint?: string; action?: React.ReactNode }) {
  const tc = useTranslations('problem');
  return (
    <Alert variant="destructive">
      <AlertTitle>{error instanceof ApiError ? error.problem.title : tc('default')}</AlertTitle>
      {hint && <AlertDescription className="text-foreground!">{hint}</AlertDescription>}
      {action && <AlertAction>{action}</AlertAction>}
    </Alert>
  );
}

export function DocEditor({ descriptor: d, mode, initial, onIssued, onRevisionRequested }: DocEditorProps) {
  const t = useTranslations('docEditor');
  const locale = useLocale();
  const router = useRouter();
  const qc = useQueryClient();
  const { me } = useMe();
  const ids = useId();
  const root = useRef<HTMLDivElement>(null);
  const missingRef = useRef<HTMLElement>(null);
  const issuing = useRef(false);

  const [header, setHeader] = useState<DocHeader>(initial?.header ?? { documentDate: todayIso() });
  const [lines, setLines] = useState<DocLine[]>(initial?.lines.length ? initial.lines : [newLine()]);
  const [party, setParty] = useState<PartySummary | undefined>(initial?.party);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [want, setWant] = useState<string>(); // Ctrl+Enter pressed while computing: open the dialog once THIS input is computed
  const [issuingNow, setIssuingNow] = useState(false);
  const [issueError, setIssueError] = useState<unknown>();
  const [journalOpen, setJournalOpen] = useState(false);
  const [previewChoice, setPreviewChoice] = useState<boolean>();
  const wide = useWide();
  const previewOpen = previewChoice ?? wide;

  // Blank rows are never sent; money/quantity text is normalised to the wire format.
  const payload = useMemo<DocInput>(() => ({
    header,
    lines: lines.filter((l) => !isBlankLine(l)).map((l) => ({ ...l, qty: qtyText(l.qty), unitPrice: moneyText(l.unitPrice) })),
  }), [header, lines]);
  const payloadJson = JSON.stringify(payload);

  const invalidate = () => { if (me) void qc.invalidateQueries({ queryKey: [me.activeCompanyId, 'docs', d.type] }); };
  const compute = useCompute(d.type, payload);
  const autosave = useAutosave({
    type: d.type, payload, enabled: mode !== 'revise',
    initial: mode === 'edit-draft' && initial ? { id: initial.id, version: initial.version } : undefined,
    onCreated: (id) => { router.replace(routesOf(d).edit(id)); invalidate(); },
  });

  const title = locale === 'en' ? d.titleEn : d.titleTh;
  const partyKind = d.partyKind;
  const missing = compute.data?.missing; // gates the actions: only a settled answer to the current input counts
  const canAct = !!me?.permissions.includes(mode === 'revise' ? d.permissions.correct : d.permissions.issue);
  const why = me && !canAct ? 'permission'
    : autosave.status === 'conflict' ? 'conflict'
    : compute.pending || compute.error ? 'computing'
    : missing?.length ? 'missing' : undefined;
  const ready = canAct && !why;
  const dialogOpen = confirmOpen || (want === payloadJson && ready);

  const jump = (field: string) => {
    const sel = field.startsWith('header.partyId') ? '[data-field="party"]' : '[data-cell="0:description"]';
    root.current?.querySelector<HTMLElement>(sel)?.focus();
  };

  const primary = () => {
    if (mode === 'revise') {
      if (ready) onRevisionRequested?.(payload); else missingRef.current?.focus();
    } else if (compute.pending && canAct && autosave.status !== 'conflict') setWant(payloadJson);
    else if (ready) setConfirmOpen(true);
    else missingRef.current?.focus();
  };

  const confirmIssue = async () => {
    if (issuing.current) return;
    issuing.current = true;
    setConfirmOpen(false); setWant(undefined); setIssuingNow(true); setIssueError(undefined);
    try {
      const saved = await autosave.flush(); // the draft must hold exactly what was confirmed
      if (!saved) return; // the save failure is already on screen
      const doc = await endpoints.issueDoc(d.type, saved.id, saved.version);
      invalidate();
      onIssued(doc);
    } catch (e) {
      setIssueError(e);
    } finally {
      issuing.current = false; setIssuingNow(false);
    }
  };

  const onPickParty = async (p: PartySummary) => {
    const first = p.usualItemIds?.[0];
    let item: ItemSummary | undefined;
    if (first && lines.length > 0 && isBlankLine(lines[0])) { try { item = await itemById(first); } catch { /* the prefill is a convenience */ } }
    setParty(p);
    setHeader((h) => ({ ...h, partyId: p.id, dueDate: addDays(h.documentDate, p.paymentTermDays) }));
    if (item) {
      setLines((ls) => ls.length > 0 && isBlankLine(ls[0])
        ? [{ ...ls[0], itemId: item.id, description: item.name, unit: item.unit, unitPrice: moneyText(item.unitPrice), taxCode: item.taxCode }, ...ls.slice(1)]
        : ls);
    }
  };

  const onKeyDownCapture = (e: KeyboardEvent) => {
    if (confirmOpen || isComposing(e) || !(e.ctrlKey || e.metaKey)) return;
    if (e.code === 'Enter' || e.code === 'NumpadEnter') { e.preventDefault(); e.stopPropagation(); primary(); }
    else if (e.code === 'KeyS') { e.preventDefault(); e.stopPropagation(); if (mode !== 'revise') void autosave.flush(); }
  };

  const amounts = useMemo(() => Object.fromEntries((compute.data?.lines ?? []).map((l) => [l.id, l.net])), [compute.data]);
  const heading = mode === 'create' ? t('create', { title }) : mode === 'edit-draft' ? t('editDraft', { title }) : t('revise', { title });
  const primaryLabel = mode === 'revise' ? t('saveRevision') : d.issueLabelTh;
  const conflict = autosave.status === 'conflict' || (issueError instanceof ApiError && issueError.problem.status === 409);
  const reload = <Button size="sm" variant="outline" onClick={() => window.location.reload()}>{t('reload')}</Button>;

  return (
    <div ref={root} onKeyDownCapture={onKeyDownCapture} className="grid gap-6 pb-28">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-title font-semibold">{heading}</h1>
        {initial?.number && <span className="tabular-nums text-muted-foreground">{initial.number}</span>}
        <StatusChip status={initial?.status ?? 'draft'} />
      </div>

      {conflict && <ProblemBanner error={autosave.status === 'conflict' ? autosave.problem : issueError} hint={t('conflictHint')} action={reload} />}
      {autosave.status === 'error' && <ProblemBanner error={autosave.problem} hint={t('saveFailedHint')}
        action={<Button size="sm" variant="outline" onClick={() => void autosave.flush()}>{t('save')}</Button>} />}
      {!!issueError && !conflict && <ProblemBanner error={issueError} hint={t('issueFailed')} />}

      <div className={cn('grid gap-6', wide && previewOpen && 'grid-cols-[minmax(0,1fr)_minmax(0,28rem)]')}>
        <div className="grid min-w-0 gap-6">
          <section className="grid gap-4 rounded-xl bg-card p-4 ring-1 ring-foreground/10 md:grid-cols-2">
            {partyKind && (
              <div className="md:col-span-2">
                <PartyField kind={partyKind} value={party} onPick={(p) => void onPickParty(p)}
                  onClear={() => { setParty(undefined); setHeader((h) => ({ ...h, partyId: undefined })); }}
                  search={(q) => endpoints.searchParties({ kind: partyKind === 'employee' ? undefined : partyKind, q, limit: 8 }).then((p) => p.items)} />
              </div>
            )}
            <div className="grid gap-1.5">
              <Label htmlFor={`${ids}-date`}>{t('documentDate')}</Label>
              <Input id={`${ids}-date`} type="date" value={header.documentDate} onChange={(e) => setHeader((h) => ({ ...h, documentDate: e.target.value }))} />
              {header.documentDate && <p className="text-small text-muted-foreground">{formatDateBE(header.documentDate)}</p>}
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={`${ids}-due`}>{t('dueDate')}</Label>
              <Input id={`${ids}-due`} type="date" value={header.dueDate ?? ''} onChange={(e) => setHeader((h) => ({ ...h, dueDate: e.target.value || undefined }))} />
              {header.dueDate && <p className="text-small text-muted-foreground">{formatDateBE(header.dueDate)}</p>}
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={`${ids}-ref`}>{t('reference')}</Label>
              <Input id={`${ids}-ref`} type="text" autoComplete="off" value={header.reference ?? ''} onChange={(e) => setHeader((h) => ({ ...h, reference: e.target.value }))} />
            </div>
            <div className="grid gap-1.5 md:col-span-2">
              <Label htmlFor={`${ids}-notes`}>{t('notes')}</Label>
              <Textarea id={`${ids}-notes`} value={header.notes ?? ''} onChange={(e) => setHeader((h) => ({ ...h, notes: e.target.value }))} />
            </div>
          </section>

          <section aria-labelledby={`${ids}-lines`} className="grid gap-3 rounded-xl bg-card p-4 ring-1 ring-foreground/10">
            <h2 id={`${ids}-lines`} className="text-section font-semibold">{t('lines.title')}</h2>
            <LineGrid lines={lines} onChange={setLines} searchItems={searchItems} amounts={amounts} computing={compute.pending} />
          </section>

          <div className="grid gap-6 lg:grid-cols-2">
            <MissingSummary ref={missingRef} missing={compute.last?.missing} pending={compute.pending || !!compute.error} partyChosen={!!header.partyId}
              partyLabel={partyKind ? t(`party.${partyKind}`) : undefined} onJump={jump} />
            <TotalsPanel totals={compute.data?.totals} pending={compute.pending} error={compute.error} onRetry={compute.retry} />
          </div>
        </div>
        <PreviewDrawer open={previewOpen} onOpenChange={setPreviewChoice} docked={wide} party={party} lines={lines} compute={compute.data} />
      </div>

      <div className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-card px-4 py-3">
        <div className="mx-auto flex max-w-screen-2xl flex-wrap items-center justify-between gap-3">
          <div className="grid gap-0.5">
            <p role="status" className="text-small text-muted-foreground">
              {['pending', 'saving', 'saved'].includes(autosave.status) ? t(`status.${autosave.status as 'pending' | 'saving' | 'saved'}`) : ''}
            </p>
            <p className="hidden text-small text-muted-foreground md:block">{t('shortcuts')}</p>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            {why && <p id={`${ids}-why`} className="text-small text-muted-foreground">{t(`whyDisabled.${why}`)}</p>}
            <Button type="button" variant="outline" aria-pressed={previewOpen} onClick={() => setPreviewChoice(!previewOpen)}><EyeIcon aria-hidden data-icon="inline-start" />{t('preview')}</Button>
            <Button type="button" variant="outline" onClick={() => setJournalOpen(true)}><ListTreeIcon aria-hidden data-icon="inline-start" />{t('journal')}</Button>
            {mode !== 'revise' && <Button type="button" variant="secondary" onClick={() => void autosave.flush()}>{t('save')}</Button>}
            <Button type="button" disabled={!ready || issuingNow} aria-describedby={why ? `${ids}-why` : undefined} onClick={primary}>
              {issuingNow ? t('issuing') : primaryLabel}
            </Button>
          </div>
        </div>
      </div>

      <JournalDrawer open={journalOpen} onOpenChange={setJournalOpen} journal={compute.data?.journal} />
      {compute.data && (
        <ConfirmIssueDialog open={dialogOpen} title={t('confirm.title', { title })} totals={compute.data.totals}
          onConfirm={() => void confirmIssue()} onCancel={() => { setConfirmOpen(false); setWant(undefined); }} />
      )}
    </div>
  );
}
