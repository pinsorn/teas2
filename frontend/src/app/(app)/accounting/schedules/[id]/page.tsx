'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useCompanyEpoch } from '@/app-shell/useCompanyEpoch';
import { isForbidden, useMe } from '@/app-shell/useMe';
import { docViewHref } from '@/descriptors';
import type { RecordRow } from '@/domain/records';
import type { DocLine, DocType, ScheduleFrequency, ScheduleRecord } from '@/domain/types';
import { ApiError } from '@/lib/api/client';
import { endpoints } from '@/lib/api/endpoints';
import { formatDateBE, formatMoney } from '@/lib/format';
import { qk } from '@/lib/query/keys';
import { FREQUENCIES, FormRow, Problem, fieldError, selectClass } from '@/kit/schedules/ScheduleDialogs';
import { ErrorState } from '@/kit/states/ErrorState';
import { ForbiddenState } from '@/kit/states/ForbiddenState';
import { LoadingState } from '@/kit/states/LoadingState';
import { NotFoundState } from '@/kit/states/NotFoundState';

const MANAGE = 'ledger.schedule.manage';
type Run = NonNullable<ScheduleRecord['runs']>[number] & { number?: string | null; docType?: DocType };
type View = RecordRow & Omit<ScheduleRecord, 'runs' | 'plan' | 'companyId'> & {
  runs: Run[]; plan?: (NonNullable<ScheduleRecord['plan']>[number] & { status: 'run' | 'next' | 'pending'; docId?: string; number?: string | null })[];
  runsDone: number; remaining?: string; done?: boolean; sourceNumber?: string | null; sourceType?: DocType | null; sourceLine?: string | null;
  expenseAccountName?: string | null; prepaidAccountName?: string | null; templateParty?: string | null;
};
const monthBE = (m: string) => formatDateBE(`${m}-01`).replace(/^\d+ /, '');

/** AC4: one schedule. Everything shown is what was frozen at creation (plan, accounts, template) plus the runs; the actions are run now, edit and stop. */
export default function SchedulePage() {
  return <ScheduleInner key={useCompanyEpoch()} />;
}

function ScheduleInner() {
  const { id } = useParams<{ id: string }>();
  const t = useTranslations('schedules');
  const { me, isPending: mePending, error: meError, refetch: refetchMe } = useMe();
  const q = useQuery({ queryKey: qk.record(me?.activeCompanyId ?? '', 'schedule', id), queryFn: () => endpoints.getRecord('schedule', id), enabled: !!me });
  if (meError) return <ErrorState error={meError} onRetry={() => void refetchMe()} />;
  if (mePending || q.isPending) return <LoadingState />;
  if (q.error) {
    if (q.error instanceof ApiError && q.error.code === 'record.not_found') return <NotFoundState listHref="/accounting/schedules" title={t('notFoundTitle')} body={t('notFoundBody')} />;
    return isForbidden(q.error) ? <ForbiddenState permission="ledger.read" detail={q.error instanceof ApiError ? q.error.problem.detail : undefined} /> : <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  }
  return <Loaded s={q.data as View} canManage={me!.permissions.includes(MANAGE)} companyId={me!.activeCompanyId} />;
}

function Loaded({ s, canManage, companyId }: { s: View; canManage: boolean; companyId: string }) {
  const t = useTranslations('schedules');
  const td = useTranslations('schedules.detail');
  const qc = useQueryClient();
  const hintId = useId();
  const [stopping, setStopping] = useState(false);
  const [editing, setEditing] = useState(false);
  const [done, setDone] = useState<Run | undefined>();
  const refresh = () => qc.invalidateQueries({ queryKey: [companyId] });
  const amort = s.kind === 'amortisation';
  const run = useMutation({
    mutationFn: () => endpoints.runSchedule(s.id, s.version),
    onSuccess: async (row) => { const r = (row as View).runs; setDone(r[r.length - 1]); await refresh(); },
    onError: (e) => { setDone(undefined); if (e instanceof ApiError && e.code === 'record.version_conflict') void refresh(); },
  });
  const state = s.stopped ? 'stopped' : s.done ? 'done' : s.active ? 'active' : 'ended';
  const runHref = (r: { resultDocId?: string; docType?: DocType }) => (r.resultDocId && r.docType ? docViewHref(r.docType, r.resultDocId) : undefined);
  const doneLabel = done?.number ?? done?.resultDocId ?? '';

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
      <header className="grid gap-2">
        <p className="text-small text-muted-foreground"><Link href="/accounting/schedules" className="hover:underline">{t('list')}</Link></p>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-h1 font-semibold">{s.name}</h1>
          <Badge variant={state === 'active' ? 'secondary' : 'outline'} data-testid="schedule-state">{td(`state.${state}`)}</Badge>
          <span className="text-small text-muted-foreground">{t(`kind.${s.kind}`)}</span>
        </div>
        <div className="flex flex-wrap items-start gap-2">
          <span className="inline-flex flex-col items-start gap-1">
            <Button disabled={!canManage || !s.active || run.isPending} aria-describedby={canManage ? undefined : hintId} onClick={() => { run.reset(); setDone(undefined); run.mutate(); }}>{run.isPending ? td('running') : td('runNow')}</Button>
            {canManage ? null : <span id={hintId} className="text-small text-muted-foreground">{t('needManage', { permission: MANAGE })}</span>}
          </span>
          <Button variant="outline" disabled={!canManage} onClick={() => setEditing(true)}>{td('edit')}</Button>
          <Button variant="outline" disabled={!canManage || !!s.stopped || (!s.active)} onClick={() => setStopping(true)}>{td('stop')}</Button>
        </div>
        {run.error ? <Problem error={run.error} /> : null}
        {done ? (
          <Alert role="status" data-testid="run-result">
            <AlertTitle>{amort ? td('ranMonth', { month: done.month ? monthBE(done.month) : '', amount: formatMoney(done.amount ?? '0.00') }) : td('ranDraft', { date: formatDateBE(done.at) })}</AlertTitle>
            <AlertDescription>{runHref(done) ? <Link href={runHref(done)!} className="text-primary underline">{doneLabel}</Link> : doneLabel}</AlertDescription>
          </Alert>
        ) : null}
        {s.stopped ? (
          <Alert role="status"><AlertTitle>{td('stoppedTitle', { at: formatDateBE(s.stopped.at.slice(0, 10)), by: s.stopped.by.name })}</AlertTitle>
            <AlertDescription>{s.stopped.reason ?? ''}{amort && s.remaining ? ` ${td('stoppedRemaining', { amount: formatMoney(s.remaining), account: s.prepaidAccount ?? '' })}` : ''}</AlertDescription></Alert>
        ) : null}
        {state === 'ended' ? <Alert role="status"><AlertTitle>{td('endedTitle', { n: s.endAfter ?? 0 })}</AlertTitle></Alert> : null}
      </header>

      <dl className="grid grid-cols-[repeat(auto-fit,minmax(11rem,1fr))] gap-x-6 gap-y-2 text-body" aria-label={td('summary')}>
        {amort ? (<>
          <Item label={td('source')}>{s.source && s.sourceType && docViewHref(s.sourceType, s.source.docId) ? <Link href={docViewHref(s.sourceType, s.source.docId)!} className="text-primary hover:underline">{s.sourceType} {s.sourceNumber}</Link> : s.sourceNumber ?? ''}{s.sourceLine ? <span className="block text-small text-muted-foreground">{s.sourceLine}</span> : null}</Item>
          <Item label={td('total')}><span className="tabular-nums">{formatMoney(s.total ?? '0.00')}</span></Item>
          <Item label={td('months')}>{s.months} · {td('from', { month: monthBE(s.startMonth ?? '') })}</Item>
          <Item label={td('expenseAccount')}>{s.expenseAccount} {s.expenseAccountName}</Item>
          <Item label={td('prepaidAccount')}>{s.prepaidAccount} {s.prepaidAccountName}</Item>
          <Item label={td('runsDone')}>{s.runsDone} / {s.months}</Item>
          <Item label={td('remaining', { account: s.prepaidAccount ?? '' })}><span className="tabular-nums" data-testid="remaining">{formatMoney(s.remaining ?? '0.00')}</span></Item>
        </>) : (<>
          <Item label={td('docType')}>{s.template?.type}{s.sourceNumber ? ` · ${td('copiedFrom', { number: s.sourceNumber })}` : ''}</Item>
          {s.templateParty ? <Item label={td('party')}>{s.templateParty}</Item> : null}
          <Item label={td('frequency')}>{t(`frequency.${s.frequency as ScheduleFrequency}`)}</Item>
          <Item label={td('nextRun')}><span className="tabular-nums" data-testid="next-run">{formatDateBE(s.nextRun)}</span></Item>
          <Item label={td('endAfter')}>{s.endAfter ? td('times', { n: s.endAfter }) : td('noEnd')}</Item>
          <Item label={td('runsDone')}>{s.runsDone}</Item>
        </>)}
      </dl>

      {amort && s.plan ? (
        <section aria-label={td('plan')} className="grid gap-1.5">
          <h2 className="text-section font-semibold">{td('plan')}</h2>
          <div role="region" aria-label={td('plan')} tabIndex={0} className="overflow-x-auto rounded-lg border bg-card [&_[data-slot=table-container]]:overflow-visible">
            <Table>
              <TableHeader><TableRow><TableHead>{td('month')}</TableHead><TableHead className="text-right">{td('amount')}</TableHead><TableHead>{td('status')}</TableHead><TableHead>{td('document')}</TableHead></TableRow></TableHeader>
              <TableBody>
                {s.plan.map((r) => (
                  <TableRow key={r.month} data-testid={`plan-${r.month}`} className={r.status === 'pending' ? 'text-muted-foreground' : undefined}>
                    <TableCell className="tabular-nums">{monthBE(r.month)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatMoney(r.amount)}</TableCell>
                    <TableCell>{td(`planStatus.${r.status}`)}</TableCell>
                    <TableCell className="tabular-nums">{r.docId && docViewHref('JV', r.docId) ? <Link href={docViewHref('JV', r.docId)!} className="text-primary hover:underline">{r.number}</Link> : <span aria-hidden className="text-muted-foreground">–</span>}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </section>
      ) : null}

      {!amort && s.template ? <Template template={s.template} /> : null}

      <section aria-label={td('runs')} className="grid gap-1.5">
        <h2 className="text-section font-semibold">{td('runs')}</h2>
        {s.runs.length === 0 ? <p className="text-muted-foreground">{td('noRuns')}</p> : (
          <div role="region" aria-label={td('runs')} tabIndex={0} className="overflow-x-auto rounded-lg border bg-card [&_[data-slot=table-container]]:overflow-visible">
            <Table>
              <TableHeader><TableRow><TableHead>{td('date')}</TableHead><TableHead>{td('document')}</TableHead><TableHead className="text-right">{td('amount')}</TableHead><TableHead>{td('status')}</TableHead></TableRow></TableHeader>
              <TableBody>
                {s.runs.map((r, i) => (
                  <TableRow key={i} className={r.reversed ? 'text-muted-foreground' : undefined}>
                    <TableCell className="tabular-nums">{formatDateBE(r.at)}</TableCell>
                    <TableCell className="tabular-nums">{runHref(r) ? <Link href={runHref(r)!} className="text-primary hover:underline">{r.number ?? r.docType}</Link> : r.number ?? ''}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.amount ? formatMoney(r.amount) : ''}</TableCell>
                    <TableCell>{r.reversed ? td('reversed') : amort ? td('posted') : td('draftMade')}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        {amort ? <p className="text-small text-muted-foreground">{td('reverseHint')}</p> : null}
      </section>

      {stopping ? <StopDialog s={s} onClose={() => setStopping(false)} onDone={refresh} /> : null}
      {editing ? <EditDialog s={s} onClose={() => setEditing(false)} onDone={refresh} /> : null}
    </div>
  );
}

function Item({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><dt className="text-small text-muted-foreground">{label}</dt><dd>{children}</dd></div>;
}

function Template({ template }: { template: NonNullable<ScheduleRecord['template']> }) {
  const td = useTranslations('schedules.detail');
  const amount = (l: DocLine) => (template.type === 'JV' ? (Number(l.debit ?? 0) > 0 ? l.debit! : l.credit!) : l.unitPrice);
  return (
    <section aria-label={td('template')} className="grid gap-1.5">
      <h2 className="text-section font-semibold">{td('template')}</h2>
      <p className="text-small text-muted-foreground">{td('templateHint')}</p>
      <div role="region" aria-label={td('template')} tabIndex={0} className="overflow-x-auto rounded-lg border bg-card [&_[data-slot=table-container]]:overflow-visible">
        <Table>
          <TableHeader><TableRow><TableHead>{td('line')}</TableHead>{template.type === 'JV' ? <TableHead>{td('account')}</TableHead> : <TableHead className="text-right">{td('qty')}</TableHead>}<TableHead className="text-right">{td('amount')}</TableHead>{template.type === 'JV' ? <TableHead>{td('side')}</TableHead> : null}</TableRow></TableHeader>
          <TableBody>
            {template.lines.map((l) => (
              <TableRow key={l.id}>
                <TableCell>{l.description}</TableCell>
                {template.type === 'JV' ? <TableCell className="tabular-nums">{l.accountCode}</TableCell> : <TableCell className="text-right tabular-nums">{l.qty}</TableCell>}
                <TableCell className="text-right tabular-nums">{formatMoney(amount(l))}</TableCell>
                {template.type === 'JV' ? <TableCell>{Number(l.debit ?? 0) > 0 ? td('debit') : td('credit')}</TableCell> : null}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}

/** "หยุด": the schedule never runs again; what is left stays on the prepaid account (said here). The stop is audited. */
function StopDialog({ s, onClose, onDone }: { s: View; onClose: () => void; onDone: () => Promise<unknown> }) {
  const td = useTranslations('schedules.detail');
  const id = useId();
  const [reason, setReason] = useState('');
  const stop = useMutation({ mutationFn: () => endpoints.stopSchedule(s.id, s.version, reason.trim() || undefined), onSuccess: async () => { await onDone(); onClose(); } });
  return (
    <AlertDialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{td('stopTitle', { name: s.name })}</AlertDialogTitle>
          <AlertDialogDescription>{s.kind === 'amortisation' ? td('stopBodyAmort', { amount: formatMoney(s.remaining ?? '0.00'), account: s.prepaidAccount ?? '' }) : td('stopBodyRecurring')}</AlertDialogDescription>
        </AlertDialogHeader>
        <div className="grid gap-1.5"><Label htmlFor={id}>{td('stopReason')}</Label><Input id={id} value={reason} onChange={(e) => setReason(e.target.value)} /></div>
        <Problem error={stop.error} />
        <AlertDialogFooter>
          <AlertDialogCancel>{td('cancel')}</AlertDialogCancel>
          <Button disabled={stop.isPending} onClick={() => stop.mutate()}>{stop.isPending ? td('stopping') : td('stopConfirm')}</Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** "แก้ไข": the name always; a recurring schedule also its frequency, next run, end and its template ("แก้ไขแม่แบบ": a fresh frozen copy of another document of the same type). An amortisation is frozen at creation. */
function EditDialog({ s, onClose, onDone }: { s: View; onClose: () => void; onDone: () => Promise<unknown> }) {
  const td = useTranslations('schedules.detail');
  const t = useTranslations('schedules');
  const tc = useTranslations('records.common');
  const id = useId();
  const recurring = s.kind === 'recurring';
  const [name, setName] = useState(s.name);
  const [frequency, setFrequency] = useState<ScheduleFrequency>(s.frequency);
  const [nextRun, setNextRun] = useState<string>(s.nextRun);
  const [endAfter, setEndAfter] = useState(s.endAfter ? String(s.endAfter) : '');
  const [templateDoc, setTemplateDoc] = useState('');
  const save = useMutation({
    mutationFn: () => endpoints.updateRecord('schedule', s.id, { name: name.trim(), ...(recurring ? { frequency, nextRun, endAfter: endAfter.trim() ? Number(endAfter) : null, ...(templateDoc.trim() ? { templateDocId: templateDoc.trim() } : {}) } : {}) }, s.version),
    onSuccess: async () => { await onDone(); onClose(); },
    onError: (e) => { if (e instanceof ApiError && e.code === 'record.version_conflict') void onDone(); },
  });
  const conflict = save.error instanceof ApiError && save.error.code === 'record.version_conflict';
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent aria-describedby={undefined} className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader><DialogTitle>{td('editTitle')}</DialogTitle></DialogHeader>
        <form noValidate className="grid gap-3" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
          {!recurring ? <p className="text-muted-foreground">{td('frozenHint')}</p> : null}
          <FormRow label={t('fields.name')} htmlFor={`${id}-name`} error={fieldError(save.error, 'name')}><Input id={`${id}-name`} value={name} onChange={(e) => setName(e.target.value)} /></FormRow>
          {recurring ? (<>
            <FormRow label={t('fields.frequency')} htmlFor={`${id}-freq`} error={fieldError(save.error, 'frequency')}>
              <select id={`${id}-freq`} className={selectClass} value={frequency} onChange={(e) => setFrequency(e.target.value as ScheduleFrequency)}>{FREQUENCIES.map((f) => <option key={f} value={f}>{t(`frequency.${f}`)}</option>)}</select>
            </FormRow>
            <FormRow label={t('fields.nextRun')} htmlFor={`${id}-next`} error={fieldError(save.error, 'nextRun')}><Input id={`${id}-next`} type="date" value={nextRun} onChange={(e) => setNextRun(e.target.value)} /></FormRow>
            <FormRow label={t('fields.endAfter')} htmlFor={`${id}-end`} error={fieldError(save.error, 'endAfter')}><Input id={`${id}-end`} type="number" min={1} step={1} inputMode="numeric" value={endAfter} placeholder={t('fields.endAfterHint')} onChange={(e) => setEndAfter(e.target.value)} /></FormRow>
            <FormRow label={td('templateDoc')} htmlFor={`${id}-tpl`}><Input id={`${id}-tpl`} value={templateDoc} placeholder={td('templateDocHint', { type: s.template?.type ?? '' })} onChange={(e) => setTemplateDoc(e.target.value)} /></FormRow>
          </>) : null}
          {conflict ? <Alert variant="destructive" role="alert"><AlertTitle>{tc('conflictTitle')}</AlertTitle><AlertDescription className="text-foreground!">{tc('conflictBody')}</AlertDescription></Alert> : <Problem error={save.error} />}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>{td('cancel')}</Button>
            <Button type="submit" disabled={save.isPending || !name.trim()}>{save.isPending ? t('saving') : td('save')}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
