'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useId, useState } from 'react';
import { isForbidden, useMe } from '@/app-shell/useMe';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { TooltipProvider } from '@/components/ui/tooltip';
import { docListHref, docViewHref } from '@/descriptors';
import { LIVE } from '@/domain/doc-types';
import type { Doc } from '@/domain/types';
import { endpoints, type UnregisteredAsset } from '@/lib/api/endpoints';
import { formatDateBE, formatMoney } from '@/lib/format';
import { Guarded } from '../doc-view/Guarded';
import { ErrorState } from '../states/ErrorState';
import { ForbiddenState } from '../states/ForbiddenState';
import { LoadingState } from '../states/LoadingState';
import { MoneyField } from '../opening/fields';
import { FormRow, Problem, fieldError } from '../schedules/ScheduleDialogs';
import { DepreciationPreview } from './DepreciationPreview';
import { DisposeDialog } from './DisposeDialog';

/** A page whose data is not here yet: loading, forbidden or failed - each its own state, never an empty page. */
function pending(q: { isPending: boolean; isError: boolean; error: unknown; refetch: () => unknown }, permission: string) {
  if (q.isPending) return <LoadingState />;
  if (q.isError) return isForbidden(q.error) ? <ForbiddenState permission={permission} /> : <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  return null;
}

const Item = ({ label, children, testId }: { label: string; children: React.ReactNode; testId?: string }) => (
  <div><dt className="text-small text-muted-foreground">{label}</dt><dd className="tabular-nums" data-testid={testId}>{children}</dd></div>
);

/** "แก้ไขเงื่อนไข": name, salvage, life and (a bill's asset) the start date, until a run or a disposal stands on the asset. The server refuses the rest in place. */
function TermsDialog({ asset, onClose }: { asset: Doc; onClose: () => void }) {
  const t = useTranslations('assets.terms');
  const id = useId();
  const qc = useQueryClient();
  const { me } = useMe();
  const a = asset.asset!;
  const [name, setName] = useState(a.name), [salvage, setSalvage] = useState(a.salvage), [life, setLife] = useState(String(a.lifeMonths)), [start, setStart] = useState(a.startDate);
  const go = useMutation({
    mutationFn: () => endpoints.reviseAssetTerms(asset.id, { version: asset.version, name, salvage, lifeMonths: Number(life), ...(a.source.kind === 'bill' ? { startDate: start } : {}) }),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: [me?.activeCompanyId] }); onClose(); },
  });
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent aria-describedby={undefined} className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader><DialogTitle>{t('title', { asset: asset.number ?? '' })}</DialogTitle></DialogHeader>
        <form noValidate className="grid gap-3" onSubmit={(e) => { e.preventDefault(); go.mutate(); }}>
          <FormRow label={t('name')} htmlFor={`${id}-name`}><Input id={`${id}-name`} value={name} onChange={(e) => setName(e.target.value)} /></FormRow>
          <FormRow label={t('salvage')} htmlFor={`${id}-salvage`} error={fieldError(go.error, 'salvage')}><MoneyField label={t('salvage')} value={salvage} onChange={setSalvage} /></FormRow>
          <FormRow label={t('life')} htmlFor={`${id}-life`}><Input id={`${id}-life`} type="number" min={1} step={1} inputMode="numeric" value={life} onChange={(e) => setLife(e.target.value)} /></FormRow>
          {a.source.kind === 'bill' ? <FormRow label={t('start')} htmlFor={`${id}-start`}><Input id={`${id}-start`} type="date" value={start} onChange={(e) => setStart(e.target.value)} /></FormRow> : null}
          <Problem error={go.error} />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>{t('back')}</Button>
            <Button type="submit" disabled={go.isPending || !name.trim()}>{go.isPending ? t('saving') : t('submit')}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** The paper tab of a fixed asset: the frozen terms, the running figures, the disposal (if any) and the asset's own actions. */
export function AssetSummary({ doc, permissions }: { doc: Doc; permissions: string[] }) {
  const t = useTranslations('assets.fa');
  const qc = useQueryClient();
  const { me } = useMe();
  const [open, setOpen] = useState<'dispose' | 'terms'>();
  const a = doc.asset;
  const undo = useMutation({
    mutationFn: () => endpoints.undisposeAsset(doc.id, doc.version),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: [me?.activeCompanyId] }); },
  });
  if (!a) return null;
  const live = LIVE.includes(doc.status), d = a.disposed;
  const need = (p: string) => (permissions.includes(p) ? undefined : t('needPermission', { permission: p }));
  const tiHref = d?.tiId ? docViewHref(me?.vatRegistered ? 'TI' : 'IV', d.tiId) : undefined;
  return (
    <div className="grid gap-4 text-body" data-testid="fa-summary">
      <dl className="grid grid-cols-[repeat(auto-fit,minmax(10rem,1fr))] gap-x-6 gap-y-2">
        <Item label={t('name')}>{a.name}</Item>
        <Item label={t('class')}>{a.assetClass}</Item>
        <Item label={t('source')}>{doc.header.reference ?? ''}</Item>
        <Item label={t('cost')} testId="fa-cost">{formatMoney(a.cost)}</Item>
        <Item label={t('salvage')}>{formatMoney(a.salvage)}</Item>
        <Item label={t('life')}>{t('months', { n: a.lifeMonths })}</Item>
        <Item label={t('start')}>{formatDateBE(a.startDate)}</Item>
        <Item label={t('opening')}>{formatMoney(a.opening)}</Item>
        <Item label={t('accumulated')} testId="fa-accumulated">{formatMoney(a.accumulated)}</Item>
        <Item label={t('nbv')} testId="fa-nbv">{formatMoney(a.nbv)}</Item>
      </dl>
      {d ? (
        <section aria-label={t('disposed')} className="grid gap-2 rounded-lg border border-border p-3" data-testid="fa-disposal">
          <h2 className="text-title font-semibold">{t('disposed')} · {t(d.kind === 'sale' ? 'sale' : 'writeOff')} · {formatDateBE(d.date)}</h2>
          <dl className="grid grid-cols-[repeat(auto-fit,minmax(10rem,1fr))] gap-x-6 gap-y-2">
            {d.kind === 'sale' ? <Item label={t('proceeds')}>{formatMoney(d.proceeds ?? '0.00')}</Item> : null}
            {d.kind === 'sale' ? <Item label={t('vat')}>{formatMoney(d.vat ?? '0.00')}</Item> : null}
            <Item label={t('accumulated')}>{formatMoney(d.accumulated)}</Item>
            <Item label={t('nbv')}>{formatMoney(d.nbv)}</Item>
            <Item label={t(`outcome.${d.outcome}`)} testId="fa-gainloss">{formatMoney(d.gainLoss)}</Item>
            {tiHref ? <Item label={t('invoice')}><Link className="underline underline-offset-2" href={tiHref}>{t('openInvoice')}</Link></Item> : null}
          </dl>
        </section>
      ) : null}
      {live ? (
        <TooltipProvider>
          <div role="group" aria-label={t('actions')} className="flex flex-wrap items-center gap-2">
            {!d ? <Guarded why={need('doc.FA.issue')}>{(p) => <Button {...p} onClick={() => setOpen('dispose')}>{t('dispose')}</Button>}</Guarded> : null}
            <Guarded why={need('doc.FA.correct')}>{(p) => <Button {...p} variant="outline" onClick={() => setOpen('terms')}>{t('editTerms')}</Button>}</Guarded>
            {d?.kind === 'write_off' ? <Guarded why={need('doc.FA.issue')}>{(p) => <Button {...p} variant="outline" disabled={p.disabled || undo.isPending} onClick={() => undo.mutate()}>{t('undoWriteOff')}</Button>}</Guarded> : null}
            {d?.kind === 'sale' ? <p className="text-small text-muted-foreground">{t('undoSale')}</p> : null}
          </div>
        </TooltipProvider>
      ) : null}
      {undo.error ? <Problem error={undo.error} /> : null}
      {open === 'dispose' ? <DisposeDialog asset={doc} onClose={() => setOpen(undefined)} /> : null}
      {open === 'terms' ? <TermsDialog asset={doc} onClose={() => setOpen(undefined)} /> : null}
    </div>
  );
}

/** The paper tab of a depreciation run: its frozen rows, and "คำนวณใหม่" (the latest run only; the server says otherwise). */
export function DpSummary({ doc, permissions }: { doc: Doc; permissions: string[] }) {
  const t = useTranslations('assets.dp');
  const qc = useQueryClient();
  const { me } = useMe();
  const re = useMutation({
    mutationFn: () => endpoints.recomputeDepreciation(doc.id, doc.version),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: [me?.activeCompanyId] }); },
  });
  if (!doc.dp) return null;
  return (
    <div className="grid gap-4 text-body" data-testid="dp-summary">
      <p className="font-medium">{t('month')}: <span className="tabular-nums">{doc.dp.month}</span></p>
      <DepreciationPreview rows={doc.dp.rows} total={doc.totals.total} />
      {LIVE.includes(doc.status) ? (
        <TooltipProvider>
          <div className="flex flex-wrap items-center gap-2">
            <Guarded why={permissions.includes('doc.DP.correct') ? undefined : t('needPermission', { permission: 'doc.DP.correct' })}>
              {(p) => <Button {...p} variant="outline" disabled={p.disabled || re.isPending} onClick={() => re.mutate()}>{t('recompute')}</Button>}
            </Guarded>
            <p className="text-small text-muted-foreground">{t('recomputeHint')}</p>
          </div>
        </TooltipProvider>
      ) : null}
      {re.error ? <Problem error={re.error} /> : null}
    </div>
  );
}

// ---------------------------------------------------------------- the register page (/accounting/fixed-assets/new)

function RegisterDialog({ row, onClose }: { row: UnregisteredAsset; onClose: () => void }) {
  const t = useTranslations('assets.register');
  const id = useId();
  const qc = useQueryClient();
  const router = useRouter();
  const { me } = useMe();
  const ob = row.source.kind === 'ob';
  const [name, setName] = useState(row.description), [salvage, setSalvage] = useState('0.00'), [life, setLife] = useState(row.lifeMonths ? String(row.lifeMonths) : ''), [start, setStart] = useState(row.date);
  const go = useMutation({
    mutationFn: () => endpoints.registerAsset({ source: row.source, name, salvage, lifeMonths: Number(life), ...(ob ? {} : { startDate: start }) }),
    onSuccess: async (fa) => { await qc.invalidateQueries({ queryKey: [me?.activeCompanyId] }); onClose(); const href = docViewHref('FA', fa.id); if (href) router.push(href); },
  });
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent aria-describedby={undefined} className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader><DialogTitle>{t('dialogTitle', { doc: row.docNumber })}</DialogTitle></DialogHeader>
        <form noValidate className="grid gap-3" onSubmit={(e) => { e.preventDefault(); go.mutate(); }}>
          <p className="text-small text-muted-foreground">{t('frozen', { cost: formatMoney(row.cost) })}{ob ? ` ${t('openingNote', { accumulated: formatMoney(row.accumulated ?? '0.00') })}` : ''}</p>
          <FormRow label={t('name')} htmlFor={`${id}-name`}><Input id={`${id}-name`} value={name} onChange={(e) => setName(e.target.value)} /></FormRow>
          <FormRow label={t('salvage')} htmlFor={`${id}-salvage`} error={fieldError(go.error, 'salvage')}><MoneyField label={t('salvage')} value={salvage} onChange={setSalvage} /></FormRow>
          <FormRow label={t('life')} htmlFor={`${id}-life`}><Input id={`${id}-life`} type="number" min={1} step={1} inputMode="numeric" value={life} onChange={(e) => setLife(e.target.value)} /></FormRow>
          {ob ? null : <FormRow label={t('start')} htmlFor={`${id}-start`}><Input id={`${id}-start`} type="date" min={row.date} value={start} onChange={(e) => setStart(e.target.value)} /></FormRow>}
          <Problem error={go.error} />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>{t('back')}</Button>
            <Button type="submit" disabled={go.isPending || !name.trim() || !life}>{go.isPending ? t('saving') : t('submit')}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** "ลงทะเบียนสินทรัพย์": the capex lines (bills / vouchers) and opening-balance asset rows nobody has registered yet. There is no manual asset: the source already posted the cost, and the exit for "I bought something" is to record the purchase. */
export function RegisterAssets() {
  const t = useTranslations('assets.register');
  const { me } = useMe();
  const [pick, setPick] = useState<UnregisteredAsset>();
  const q = useQuery({ queryKey: [me?.activeCompanyId ?? '', 'assets-unregistered'], queryFn: () => endpoints.unregisteredAssets(), enabled: !!me });
  const can = !!me?.permissions.includes('doc.FA.create');
  const items = q.data?.items ?? [];
  const pbHref = docListHref('PB', true);
  const wait = pending(q, 'doc.FA.read');
  if (wait) return wait;
  return (
    <div className="grid gap-4">
      <header className="grid gap-1">
        <h1 className="text-h1 font-semibold">{t('title')}</h1>
        <p className="text-body text-muted-foreground">{t('lead')}</p>
      </header>
      {!items.length ? (
        <Alert role="status" data-testid="register-none"><AlertTitle>{t('noneTitle')}</AlertTitle><AlertDescription>{t('noneBody')} {pbHref ? <Link className="underline underline-offset-2" href={`${pbHref}/new`}>{t('exitPb')}</Link> : null}</AlertDescription></Alert>
      ) : null}
      {items.length ? (
        <div className="overflow-x-auto" role="region" aria-label={t('title')} tabIndex={0}>
          <Table data-testid="register-rows">
            <TableHeader><TableRow>
              <TableHead>{t('colSource')}</TableHead><TableHead>{t('colDesc')}</TableHead><TableHead>{t('colClass')}</TableHead><TableHead className="text-right">{t('colCost')}</TableHead><TableHead />
            </TableRow></TableHeader>
            <TableBody>
              {items.map((r) => (
                <TableRow key={`${r.source.docId}-${'lineId' in r.source ? r.source.lineId : r.source.rowId}`}>
                  <TableCell className="whitespace-normal">{r.docType} {r.docNumber} · {formatDateBE(r.date)}{r.partyName ? ` · ${r.partyName}` : ''}</TableCell>
                  <TableCell className="whitespace-normal">{r.description}</TableCell>
                  <TableCell>{r.assetClass}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(r.cost)}</TableCell>
                  <TableCell className="text-right">
                    <TooltipProvider><Guarded why={can ? undefined : t('needPermission', { permission: 'doc.FA.create' })}>{(p) => <Button {...p} size="sm" variant="outline" onClick={() => setPick(r)}>{t('register')}</Button>}</Guarded></TooltipProvider>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : null}
      {pick ? <RegisterDialog row={pick} onClose={() => setPick(undefined)} /> : null}
    </div>
  );
}

// ---------------------------------------------------------------- the run page (/accounting/depreciation-runs/new)

/** "คิดค่าเสื่อมราคา": pick a month (the next one is suggested), read the table the server would post, issue it. A month that cannot be run says why and keeps the button off. */
export function RunDepreciation() {
  const t = useTranslations('assets.dp');
  const qc = useQueryClient();
  const router = useRouter();
  const { me } = useMe();
  const [picked, setPicked] = useState<string>();
  const q = useQuery({ queryKey: [me?.activeCompanyId ?? '', 'dp-preview', picked ?? ''], queryFn: () => endpoints.previewDepreciation(picked), enabled: !!me, placeholderData: (prev) => prev });
  const month = picked ?? q.data?.suggested ?? ''; // until a month is picked, the server's suggestion (the month after the latest run)
  const id = useId();
  const go = useMutation({
    mutationFn: () => endpoints.runDepreciation(month),
    onSuccess: async (dp) => { await qc.invalidateQueries({ queryKey: [me?.activeCompanyId] }); const href = docViewHref('DP', dp.id); if (href) router.push(href); },
  });
  const can = !!me?.permissions.includes('doc.DP.issue');
  const p = q.data && q.data.month === month ? q.data : undefined;
  const wait = pending(q, 'doc.DP.read');
  if (wait) return wait;
  return (
    <div className="grid gap-4">
      <header className="grid gap-1">
        <h1 className="text-h1 font-semibold">{t('runTitle')}</h1>
        <p className="text-body text-muted-foreground">{t('runLead')}</p>
      </header>
      <FormRow label={t('monthLabel')} htmlFor={`${id}-month`}><Input id={`${id}-month`} type="month" className="max-w-48" value={month} onChange={(e) => { go.reset(); setPicked(e.target.value); }} /></FormRow>
      {p?.problem ? <Alert role="alert" variant="destructive" data-testid="dp-problem"><AlertTitle>{p.problem.title}</AlertTitle></Alert> : null}
      {p ? <DepreciationPreview rows={p.rows} total={p.total} /> : null}
      {go.error ? <Problem error={go.error} /> : null}
      <div>
        <TooltipProvider>
          <Guarded why={can ? undefined : t('needPermission', { permission: 'doc.DP.issue' })}>
            {(g) => <Button {...g} disabled={g.disabled || !p || !!p.problem || go.isPending} onClick={() => go.mutate()}>{go.isPending ? t('issuing') : t('issue')}</Button>}
          </Guarded>
        </TooltipProvider>
      </div>
    </div>
  );
}
