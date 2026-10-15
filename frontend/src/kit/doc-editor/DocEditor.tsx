'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { EyeIcon, ListTreeIcon } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react';
import { useCompanyEpoch } from '@/app-shell/useCompanyEpoch';
import { useMe } from '@/app-shell/useMe';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { routesOf, type DocDescriptor } from '@/domain/descriptors';
import type { Allocation, Doc, DocHeader, DocLine, ItemSummary, Me, PartySummary } from '@/domain/types';
import { ApiError } from '@/lib/api/client';
import { endpoints, type DocInput } from '@/lib/api/endpoints';
import { qk } from '@/lib/query/keys';
import { cn } from '@/lib/utils';
import { ConfirmIssueDialog } from '../dialogs/ConfirmIssueDialog';
import { StatusChip } from '../doc-list/StatusChip';
import { GroupPanel } from './GroupPanel';
import { HeaderFields } from './HeaderFields';
import { JournalDrawer } from './JournalDrawer';
import { isBlankLine, LineGrid, newLine } from './LineGrid';
import { MissingSummary } from './MissingSummary';
import { PartyField } from './PartyField';
import { PreviewDrawer } from './PreviewDrawer';
import { SettlementPanel } from './SettlementPanel';
import { TotalsPanel } from './TotalsPanel';
import { useAutosave } from './useAutosave';
import { useCompute } from './useCompute';
import { cleanDecimal, isComposing, moneyText, qtyText } from './useLineGridKeys';

export interface DocEditorProps {
  descriptor: DocDescriptor;
  mode: 'create' | 'edit-draft' | 'revise';
  initial?: Doc;
  onIssued: (doc: Doc) => void;
  onRevisionRequested?: (proposed: { header: DocHeader; lines: DocLine[]; allocations?: Allocation[] }) => void; // revise mode: hands off to the correction plan
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

/** Calendar-date arithmetic for the payment-terms due date (not money, not tax). */
const addDays = (iso: string, n: number) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
/** Customer documents sell, everything else buys: the type-ahead offers only the items usable on that side. */
type Usage = 'sales' | 'purchase';
async function itemById(id: string, usage: Usage): Promise<ItemSummary | undefined> {
  const hit = (await endpoints.searchItems({ q: id, limit: 5, usage })).items.find((i) => i.id === id);
  return hit ?? (await endpoints.searchItems({ limit: 200, usage })).items.find((i) => i.id === id);
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

/** Keyed by the active company: a switch starts a fresh editor (nothing typed for company A is ever saved into B). */
export function DocEditor(props: DocEditorProps) {
  return <DocEditorInner key={useCompanyEpoch()} {...props} />;
}

function DocEditorInner({ descriptor: d, mode, initial, onIssued, onRevisionRequested }: DocEditorProps) {
  const t = useTranslations('docEditor');
  const ts = useTranslations('docEditor.settlement');
  const td = useTranslations(`docTypes.${d.type}`);
  const locale = useLocale();
  const qc = useQueryClient();
  const { me } = useMe();
  const owner = useRef<string>(undefined); // the company this editor belongs to
  useEffect(() => { owner.current ??= me?.activeCompanyId; });
  const ids = useId();
  const root = useRef<HTMLDivElement>(null);
  const missingRef = useRef<HTMLElement>(null);
  const issuing = useRef(false);
  const pickGen = useRef(0); // newest party selection wins: older usual-item lookups are dropped
  const [stale, setStale] = useState(false);
  const [partyBusy, setPartyBusy] = useState(false); // a party lookup / pick (with its usual-item prefill) is still landing
  const [picking, setPicking] = useState(false);

  const [header, setHeader] = useState<DocHeader>(initial?.header ?? { documentDate: me?.businessDate ?? '' });
  // /me can land after the first render (tests, direct mounts): a blank new document takes the server's business date as soon as it is known
  // ONCE: a date the user later clears or edits is theirs, never refilled.
  const [dateAdopted, setDateAdopted] = useState(!!initial || !!me?.businessDate);
  if (!dateAdopted && me?.businessDate) { setDateAdopted(true); setHeader((h) => (h.documentDate ? h : { ...h, documentDate: me.businessDate })); }
  const exemptOnly = d.lineEditor === 'amount' && d.headerFields.includes('whtMode'); // a voucher: input VAT only through a bill (PB)
  const [lines, setLines] = useState<DocLine[]>(initial?.lines.length ? initial.lines : [newLine(exemptOnly || (me && !me.vatRegistered) ? 'EX' : 'S7')]); // a non-VAT company sells without VAT
  const [party, setParty] = useState<PartySummary | undefined>(initial?.party);
  const [allocations, setAllocations] = useState<Allocation[]>(initial?.allocations ?? []); // RC / PV: the open items this document settles
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [want, setWant] = useState<string>(); // Ctrl+Enter pressed while computing: open the dialog once THIS input is computed
  const [issuingNow, setIssuingNow] = useState(false);
  const [issueError, setIssueError] = useState<unknown>();
  const [journalOpen, setJournalOpen] = useState(false);
  const [previewChoice, setPreviewChoice] = useState<boolean>();
  const wide = useWide();
  const previewOpen = previewChoice ?? wide;

  // Blank rows are never sent (nor, on a debit note opened from an invoice, a line left at quantity 0 - the prefill starts them there); money/quantity text is normalised to the wire format.
  const payload = useMemo<DocInput>(() => ({
    header,
    lines: lines.filter((l) => !isBlankLine(l) && !(d.type === 'DN' && d.adjusts && Number(qtyText(l.qty)) === 0)).map((l) => ({ ...l, qty: qtyText(l.qty), unitPrice: moneyText(l.unitPrice) })),
    ...(d.settles || d.groups ? { allocations } : {}),
  }), [header, lines, allocations, d.settles, d.groups, d.type, d.adjusts]);
  const payloadJson = JSON.stringify(payload);

  const invalidate = () => {
    if (!me) return;
    void qc.invalidateQueries({ queryKey: [me.activeCompanyId, 'docs', d.type] });
    if (d.settles) void qc.invalidateQueries({ queryKey: [me.activeCompanyId, 'open-items'] }); // the targets' balances just changed
  };
  const compute = useCompute(d.type, payload, mode === 'revise' ? initial?.id : undefined); // revising: the document's own settlements are not 'used up'
  const autosave = useAutosave({
    type: d.type, payload, enabled: mode !== 'revise',
    initial: mode === 'edit-draft' && initial ? { id: initial.id, version: initial.version } : undefined,
    startUnsaved: mode === 'create' && !!initial,
    flushOnLeave: () => qc.getQueryData<Me>(qk.me())?.activeCompanyId === owner.current,
    // the address bar follows the draft, but the editor stays mounted (a router navigation would remount it and lose focus / input)
    onCreated: (id) => { if (root.current) window.history.replaceState(window.history.state, '', routesOf(d).edit(id)); invalidate(); },
  });

  const title = locale === 'en' ? d.titleEn : d.titleTh;
  const partyKind = d.partyKind;
  const usage: Usage = partyKind === 'customer' ? 'sales' : 'purchase';
  const searchItems = useCallback((q: string) => endpoints.searchItems({ q, limit: 8, usage }).then((p) => p.items), [usage]);
  const showLines = d.lineEditor !== 'none' && !(d.linesWhen === 'non-vat' && me?.vatRegistered !== false); // D-12: a VAT company's receipt settles invoices, it has no line grid
  const amountEditor = d.lineEditor === 'amount';
  const withholds = d.headerFields.includes('whtMode'); // only a document that pays out withholds tax from its lines
  const whtTypes = useQuery({ queryKey: qk.whtTypes(me?.activeCompanyId ?? ''), queryFn: endpoints.whtTypes, enabled: !!me && amountEditor && withholds });
  const missing = compute.data?.missing; // gates the actions: only a settled answer to the current input counts
  const canAct = !!me?.permissions.includes(mode === 'revise' ? d.permissions.create : d.permissions.issue);
  const why = me && !canAct ? 'permission'
    : autosave.status === 'conflict' ? 'conflict'
    : amountEditor && withholds && whtTypes.isError ? 'whtTypes'
    : compute.pending || compute.error || partyBusy || picking || (amountEditor && withholds && whtTypes.isPending) ? 'computing'
    : missing?.length ? 'missing' : undefined;
  const ready = canAct && !why;
  const dialogOpen = confirmOpen || (want === payloadJson && ready);

  const jump = (field: string) => {
    const sel = field.startsWith('header.partyId') ? '[data-field="party"]' : field === 'allocations' ? '[role="checkbox"]' : '[data-cell="0:description"]';
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
    const confirmed = payloadJson;
    setConfirmOpen(false); setWant(undefined); setIssuingNow(true); setIssueError(undefined); setStale(false);
    try {
      const saved = await autosave.flush(); // the draft must hold exactly what was confirmed
      if (!saved) return; // the save failure is already on screen
      if (saved.json !== confirmed) { setStale(true); return; } // never issue content the user did not confirm
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
    const gen = ++pickGen.current;
    setPicking(true);
    const first = p.usualItemIds?.[0];
    let item: ItemSummary | undefined;
    if (first && lines.length > 0 && isBlankLine(lines[0])) { try { item = await itemById(first, usage); } catch { /* the prefill is a convenience */ } }
    if (gen !== pickGen.current) return;
    setPicking(false);
    if (p.id !== header.partyId) setAllocations([]); // the ticked open items belong to the previous party
    setParty(p);
    setHeader((h) => ({ ...h, partyId: p.id, dueDate: addDays(h.documentDate, p.paymentTermDays) }));
    if (item && showLines) {
      setLines((ls) => ls.length > 0 && isBlankLine(ls[0])
        ? [{ ...ls[0], itemId: item.id, description: item.name, unit: item.unit, unitPrice: moneyText(item.unitPrice), taxCode: exemptOnly ? 'EX' : item.taxCode,
          ...(amountEditor && withholds && item.whtTypeCode ? { whtTypeCode: item.whtTypeCode } : {}) }, ...ls.slice(1)]
        : ls);
    }
  };

  const onKeyDownCapture = (e: KeyboardEvent) => {
    if (confirmOpen || isComposing(e) || !(e.ctrlKey || e.metaKey)) return;
    if (e.code === 'Enter' || e.code === 'NumpadEnter') { e.preventDefault(); e.stopPropagation(); primary(); }
    else if (e.code === 'KeyS') { e.preventDefault(); e.stopPropagation(); if (mode !== 'revise') void autosave.flush(); }
  };

  const amounts = useMemo(() => Object.fromEntries((compute.data?.lines ?? []).map((l) => [l.id, l.net])), [compute.data]);
  const heading = mode === 'create' ? td('create') : mode === 'edit-draft' ? t('editDraft', { title }) : t('revise', { title });
  const primaryLabel = mode === 'revise' ? t('saveRevision') : td('issue');
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
      {stale && <Alert variant="destructive"><AlertDescription className="text-foreground!">{t('staleConfirm')}</AlertDescription></Alert>}
      {!!issueError && !conflict && <ProblemBanner error={issueError} hint={t('issueFailed')} />}

      <fieldset disabled={issuingNow} className={cn('m-0 grid min-w-0 gap-6 border-0 p-0', wide && previewOpen && 'grid-cols-[minmax(0,1fr)_minmax(0,28rem)]')}>
        <div className="grid min-w-0 gap-6">
          <section className="grid gap-4 rounded-xl bg-card p-4 ring-1 ring-foreground/10 md:grid-cols-2">
            {d.adjusts ? ( // a note's customer is its invoice's: the server fills it, the editor only shows it
              <div className="grid gap-1 md:col-span-2">
                <p className="text-small text-muted-foreground">{t('adjust.partyFixed')}</p>
                <p className="text-body font-medium" data-field="party-fixed">{party?.name ?? '-'}</p>
              </div>
            ) : partyKind && (
              <div className="md:col-span-2">
                <PartyField kind={partyKind} value={party} onPick={(p) => void onPickParty(p)} canCreate={me ? me.permissions.includes('party.manage') : undefined}
                  onPending={setPartyBusy} onClear={() => { pickGen.current++; setPicking(false); setParty(undefined); setAllocations([]); setHeader((h) => ({ ...h, partyId: undefined })); }}
                  search={(q) => endpoints.searchParties({ kind: partyKind === 'employee' ? undefined : partyKind, q, limit: 8 }).then((p) => p.items)} />
              </div>
            )}
            <HeaderFields type={d.type} keys={d.headerFields} ids={ids} header={header} setHeader={setHeader} />
          </section>

          {d.settles && (
            <SettlementPanel descriptor={d} partyId={header.partyId} value={allocations} onChange={setAllocations} allocation={compute.last?.allocation} />
          )}

          {d.type === 'RC' && ( // the part of the money no document takes: the server keeps it as a customer deposit
            <section className="grid gap-1.5 rounded-xl bg-card p-4 ring-1 ring-foreground/10 md:max-w-md">
              <Label htmlFor={`${ids}-deposit`}>{ts('deposit')}</Label>
              <Input id={`${ids}-deposit`} type="text" inputMode="decimal" autoComplete="off" className="text-right tabular-nums" value={header.depositAmount ?? ''}
                onChange={(e) => setHeader((h) => ({ ...h, depositAmount: cleanDecimal(e.target.value, 2) || undefined }))}
                onBlur={() => setHeader((h) => (h.depositAmount && moneyText(h.depositAmount) !== h.depositAmount ? { ...h, depositAmount: moneyText(h.depositAmount) } : h))}
                onFocus={(e) => e.target.select()} />
              <p className="text-small text-muted-foreground">{ts('depositHint')}</p>
            </section>
          )}

          {d.groups && (
            <GroupPanel descriptor={d} partyId={header.partyId} value={allocations} onChange={setAllocations} total={compute.last?.totals.total} />
          )}

          {showLines && (
            <section aria-labelledby={`${ids}-lines`} className="grid gap-3 rounded-xl bg-card p-4 ring-1 ring-foreground/10">
              <h2 id={`${ids}-lines`} className="text-section font-semibold">{t('lines.title')}</h2>
              <LineGrid lines={lines} onChange={setLines} searchItems={searchItems} amounts={amounts} computing={compute.pending}
                variant={amountEditor ? 'amount' : 'item'} showCategory={partyKind === 'vendor' || partyKind === 'employee'} whtTypes={withholds ? (whtTypes.data ?? []) : undefined}
                whtError={withholds && whtTypes.isError ? whtTypes.error : undefined} onWhtRetry={() => void whtTypes.refetch()} exemptOnly={exemptOnly} />
            </section>
          )}

          <div className="grid gap-6 lg:grid-cols-2">
            <MissingSummary ref={missingRef} missing={compute.last?.missing} pending={compute.pending || !!compute.error} partyChosen={!!header.partyId}
              partyLabel={partyKind ? t(`party.${partyKind}`) : undefined} onJump={jump} />
            <TotalsPanel totals={compute.data?.totals} whtLines={compute.data?.whtLines} pending={compute.pending} error={compute.error} onRetry={compute.retry} />
          </div>
        </div>
        <PreviewDrawer open={previewOpen} onOpenChange={setPreviewChoice} docked={wide} party={party} lines={lines} compute={compute.data} />
      </fieldset>

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
            {me && !me.permissions.includes('ledger.read') ? (
              <span title={t('journalNeedsPermission')}>
                <Button type="button" variant="outline" disabled><ListTreeIcon aria-hidden data-icon="inline-start" />{t('journal')}<span className="sr-only"> ({t('journalNeedsPermission')})</span></Button>
              </span>
            ) : <Button type="button" variant="outline" onClick={() => setJournalOpen(true)}><ListTreeIcon aria-hidden data-icon="inline-start" />{t('journal')}</Button>}
            {mode !== 'revise' && <Button type="button" variant="secondary" onClick={() => void autosave.flush()}>{t('save')}</Button>}
            <Button type="button" disabled={!ready || issuingNow} aria-describedby={why ? `${ids}-why` : undefined} onClick={primary}>
              {issuingNow ? t('issuing') : primaryLabel}
            </Button>
          </div>
        </div>
      </div>

      <JournalDrawer open={journalOpen} onOpenChange={setJournalOpen} journal={compute.data?.journal} pending={compute.pending} error={compute.error} onRetry={compute.retry} />
      {compute.data && (
        <ConfirmIssueDialog open={dialogOpen} title={t('confirm.title', { title })} totals={compute.data.totals}
          onConfirm={() => void confirmIssue()} onCancel={() => { setConfirmOpen(false); setWant(undefined); }} />
      )}
    </div>
  );
}
