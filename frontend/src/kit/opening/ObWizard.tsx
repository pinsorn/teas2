'use client';
import { useQueryClient } from '@tanstack/react-query';
import { CheckIcon, XIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useMemo, useRef, useState } from 'react';
import { useCompanyEpoch } from '@/app-shell/useCompanyEpoch';
import { useMe } from '@/app-shell/useMe';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { ForbiddenState } from '../states/ForbiddenState';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { openingBalance } from '@/descriptors/opening-balance';
import { routesOf } from '@/domain/descriptors';
import type { Doc, DocHeader, DocLine, DocOpening } from '@/domain/types';
import { ApiError } from '@/lib/api/client';
import { endpoints, type DocInput } from '@/lib/api/endpoints';
import { formatMoney } from '@/lib/format';
import { accountLinePayload, isBlankAccountLine, newAccountLine } from '../doc-editor/AccountLineGrid';
import { useAutosave } from '../doc-editor/useAutosave';
import { useCompute } from '../doc-editor/useCompute';
import { ObAssetsStep } from './ObAssetsStep';
import { ObBankStep } from './ObBankStep';
import { ObOpenItemsStep } from './ObOpenItemsStep';
import { ObPayrollYtdStep } from './ObPayrollYtdStep';
import { ObTrialBalanceStep } from './ObTrialBalanceStep';

const STEPS = ['tb', 'bank', 'items', 'assets', 'payroll', 'review'] as const;
const EMPTY: DocOpening = { openItems: [], assets: [], payrollYtd: [], bank: [] };
const routes = routesOf(openingBalance);

/** The last day of the month before `businessDate`'s month: the usual cut-off (the day before the books start). */
const urlCutoff = (): string | undefined => {
  try { const c = new URLSearchParams(window.location.search).get('cutoff'); return c && /^\d{4}-\d{2}-\d{2}$/.test(c) ? c : undefined; } catch { return undefined; }
};
const defaultCutoff = (businessDate?: string) => {
  if (!businessDate) return '';
  const [y, m] = businessDate.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 0)).toISOString().slice(0, 10);
};
/** Rows the person never touched are not sent. */
const touched = (o: object) => Object.values(o).some((v) => (typeof v === 'string' ? v.trim() !== '' && v !== '0.00' : Array.isArray(v) ? v.length > 0 : false));
const clean = (o: DocOpening): DocOpening => ({
  openItems: o.openItems.filter(touched),
  assets: o.assets.filter((a) => a.name.trim() || a.cost || a.acquired),
  payrollYtd: o.payrollYtd.filter(touched),
  bank: o.bank.filter((b) => b.accountId || b.statement || b.inTransit.length).map((b) => ({ ...b, inTransit: b.inTransit.filter(touched) })),
});

export interface ObWizardProps {
  /** A saved draft (edit) or an issued batch (revise). Absent: a new one. */
  initial?: Doc;
  mode: 'create' | 'edit-draft' | 'revise';
  onIssued?: (doc: Doc) => void;
  /** revise: hands the proposal to the correction plan. */
  onRevisionRequested?: (proposed: DocInput) => void;
}

/** Keyed by the active company: a switch starts a fresh wizard (nothing typed for company A is ever saved into B). */
export function ObWizard(props: ObWizardProps) {
  return <ObWizardInner key={useCompanyEpoch()} {...props} />;
}

function Problem({ error }: { error: unknown }) {
  const tc = useTranslations('problem');
  return <Alert variant="destructive" role="alert"><AlertTitle>{error instanceof ApiError ? error.problem.title : tc('default')}</AlertTitle></Alert>;
}

function ObWizardInner({ initial, mode, onIssued, onRevisionRequested }: ObWizardProps) {
  const t = useTranslations('opening');
  const router = useRouter();
  const qc = useQueryClient();
  const { me } = useMe();
  const revise = mode === 'revise';
  const [step, setStep] = useState(0);
  // HC3: the onboarding wizard lands here with the cut-off it asked for (?cutoff=YYYY-MM-DD); the server still judges it
  const [header, setHeader] = useState<DocHeader>(initial?.header ?? { documentDate: urlCutoff() ?? defaultCutoff(me?.businessDate) });
  const [dateAdopted, setDateAdopted] = useState(!!initial || !!me?.businessDate);
  if (!dateAdopted && me?.businessDate) { setDateAdopted(true); setHeader((h) => (h.documentDate ? h : { ...h, documentDate: defaultCutoff(me.businessDate) })); }
  const [lines, setLines] = useState<DocLine[]>(initial?.lines.length ? initial.lines : [newAccountLine(), newAccountLine()]);
  const [opening, setOpening] = useState<DocOpening>(initial?.opening ?? EMPTY);
  const [issueError, setIssueError] = useState<unknown>();
  const [issuingNow, setIssuingNow] = useState(false);
  const issuing = useRef(false);

  const payload = useMemo<DocInput>(() => ({ header, lines: lines.filter((l) => !isBlankAccountLine(l)).map(accountLinePayload), opening: clean(opening) }), [header, lines, opening]);
  const autosave = useAutosave({ type: 'OB', payload, enabled: !revise, ...(initial && !revise ? { initial: { id: initial.id, version: initial.version } } : {}),
    onCreated: (id) => { window.history.replaceState(window.history.state, '', routes.edit(id)); } });
  const compute = useCompute('OB', payload, revise ? initial?.id : undefined);
  const check = compute.data ?? compute.last;
  const missing = compute.data?.missing;

  const ready = !compute.pending && !compute.error && autosave.status !== 'conflict' && !missing?.length;
  const why = autosave.status === 'conflict' ? t('why.conflict') : compute.pending || compute.error ? t('why.computing') : missing?.length ? t('why.missing') : undefined;
  const last = step === STEPS.length - 1;

  const submit = async () => {
    if (issuing.current || !ready) return;
    issuing.current = true; setIssuingNow(true); setIssueError(undefined);
    try {
      if (revise) { onRevisionRequested?.(payload); return; }
      const saved = await autosave.flush();
      if (!saved) return;
      const doc = await endpoints.issueDoc('OB', saved.id, saved.version);
      if (me) await qc.invalidateQueries({ queryKey: [me.activeCompanyId] });
      (onIssued ?? ((d: Doc) => router.replace(routes.view(d.id))))(doc);
    } catch (e) {
      setIssueError(e);
    } finally {
      issuing.current = false; setIssuingNow(false);
    }
  };

  if (me && !me.permissions.includes(openingBalance.permissions.create)) return <ForbiddenState permission={openingBalance.permissions.create} />;
  return (
    <div className="grid gap-4" data-testid="ob-wizard">
      <header className="grid gap-1">
        <h1 className="text-h1 font-semibold">{revise ? t('titleRevise') : t('title')}</h1>
        <p role="status" className="text-small text-muted-foreground" data-testid="ob-save-status">{revise ? '' : t(`save.${autosave.status}`)}</p>
      </header>
      <nav aria-label={t('stepper')}>
        <ol className="flex flex-wrap gap-2">
          {STEPS.map((k, i) => (
            <li key={k}>
              <Button type="button" size="sm" variant={i === step ? 'default' : 'outline'} aria-current={i === step ? 'step' : undefined} onClick={() => setStep(i)}>
                <span className="tabular-nums">{i + 1}</span> {t(`steps.${k}`)}
              </Button>
            </li>
          ))}
        </ol>
      </nav>
      <section aria-label={t(`steps.${STEPS[step]}`)} className="grid gap-4">
        <h2 className="text-title font-semibold">{t('stepOf', { n: step + 1, total: STEPS.length })} · {t(`steps.${STEPS[step]}`)}</h2>
        {STEPS[step] === 'tb' ? <ObTrialBalanceStep header={header} onHeader={setHeader} lines={lines} onLines={setLines} compute={check} computing={compute.pending} /> : null}
        {STEPS[step] === 'bank' ? <ObBankStep value={opening.bank} onChange={(bank) => setOpening((o) => ({ ...o, bank }))} /> : null}
        {STEPS[step] === 'items' ? <ObOpenItemsStep value={opening.openItems} onChange={(openItems) => setOpening((o) => ({ ...o, openItems }))} /> : null}
        {STEPS[step] === 'assets' ? <ObAssetsStep value={opening.assets} onChange={(assets) => setOpening((o) => ({ ...o, assets }))} /> : null}
        {STEPS[step] === 'payroll' ? <ObPayrollYtdStep value={opening.payrollYtd} onChange={(payrollYtd) => setOpening((o) => ({ ...o, payrollYtd }))} /> : null}
        {STEPS[step] === 'review' ? (
          <div className="grid gap-4" aria-busy={compute.pending}>
            {compute.error ? <Problem error={compute.error} /> : null}
            {missing?.length ? (
              <Alert variant="destructive" role="alert" data-testid="ob-missing">
                <AlertTitle>{t('review.missing')}</AlertTitle>
                <AlertDescription className="text-foreground!"><ul className="list-disc pl-5">{missing.map((m, i) => <li key={i}>{m.message}</li>)}</ul></AlertDescription>
              </Alert>
            ) : null}
            <section aria-label={t('review.checks')} className="grid gap-2">
              <h3 className="text-body font-semibold">{t('review.checks')}</h3>
              {check?.opening?.ties.length ? (
                <Table>
                  <TableHeader><TableRow><TableHead>{t('review.account')}</TableHead><TableHead className="text-right">{t('review.tb')}</TableHead><TableHead className="text-right">{t('review.step')}</TableHead><TableHead>{t('review.result')}</TableHead></TableRow></TableHeader>
                  <TableBody>
                    {check.opening.ties.map((x) => (
                      <TableRow key={x.key} data-testid={`ob-tie-${x.key}`}>
                        <TableCell className="whitespace-normal">{x.label} <span className="tabular-nums text-muted-foreground">{x.code}</span></TableCell>
                        <TableCell className="text-right tabular-nums">{formatMoney(x.tb)}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatMoney(x.sub)}</TableCell>
                        <TableCell>{x.ok ? <span className="inline-flex items-center gap-1"><CheckIcon aria-hidden className="size-4" />{t('review.ok')}</span> : <span className="inline-flex items-center gap-1 text-destructive"><XIcon aria-hidden className="size-4" />{t('review.mismatch')}</span>}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : <p className="text-body text-muted-foreground">{check ? t('review.noChecks') : t('review.computing')}</p>}
            </section>
            {check?.opening ? (
              <section aria-label={t('review.plugTitle')} className="grid gap-1 rounded-lg bg-muted/40 p-3 md:max-w-md">
                <h3 className="text-body font-semibold">{t('review.plugTitle')}</h3>
                <p className="tabular-nums" data-testid="ob-plug">{check.opening.plugSide ? `${formatMoney(check.opening.plug)} · ${t(check.opening.plugSide === 'Cr' ? 'review.plugCr' : 'review.plugDr')}` : t('review.plugNone')}</p>
                <p className="tabular-nums text-small text-muted-foreground">{t('review.total')} {formatMoney(check.opening.debit)}</p>
              </section>
            ) : null}
            {check?.journal?.entries[0] ? (
              <section aria-label={t('review.journal')} className="grid gap-2">
                <h3 className="text-body font-semibold">{t('review.journal')}</h3>
                <Table>
                  <TableHeader><TableRow><TableHead>{t('review.account')}</TableHead><TableHead className="text-right">{t('review.debit')}</TableHead><TableHead className="text-right">{t('review.credit')}</TableHead></TableRow></TableHeader>
                  <TableBody>
                    {check.journal.entries[0].lines.map((l, i) => (
                      <TableRow key={i}>
                        <TableCell className="whitespace-normal">{l.accountCode} {l.accountName}{l.partyName ? ` · ${l.partyName}` : ''}{l.rule === 'ผลต่างยกไปส่วนเกินทุนยอดยกมา' ? ` (${l.rule})` : ''}</TableCell>
                        <TableCell className="text-right tabular-nums">{Number(l.debit) ? formatMoney(l.debit) : ''}</TableCell>
                        <TableCell className="text-right tabular-nums">{Number(l.credit) ? formatMoney(l.credit) : ''}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </section>
            ) : null}
            {issueError ? <Problem error={issueError} /> : null}
          </div>
        ) : null}
      </section>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button type="button" variant="outline" disabled={step === 0} onClick={() => setStep(step - 1)}>{t('back')}</Button>
        <div className="flex flex-wrap items-center gap-2">
          {!revise ? <Button type="button" variant="secondary" onClick={() => void autosave.flush()}>{t('saveDraft')}</Button> : null}
          {last ? (
            <Button type="button" disabled={!ready || issuingNow} aria-describedby={why ? 'ob-why' : undefined} onClick={() => void submit()}>{revise ? t('revise') : t('issue')}</Button>
          ) : <Button type="button" onClick={() => setStep(step + 1)}>{t('next')}</Button>}
        </div>
      </div>
      {last && why ? <p id="ob-why" className="text-small text-muted-foreground">{why}</p> : null}
    </div>
  );
}
