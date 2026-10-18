'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { Fragment, useState, type ReactNode } from 'react';
import { Alert, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useCompanyEpoch } from '@/app-shell/useCompanyEpoch';
import { isForbidden, useMe } from '@/app-shell/useMe';
import { ApiError } from '@/lib/api/client';
import { type TaxSettings, type WhtTypeSetting, type WhtRateRow, taxApi } from '@/records/tax-numbering-approvals';
import { ErrorState } from '@/kit/states/ErrorState';
import { ForbiddenState } from '@/kit/states/ForbiddenState';
import { LoadingState } from '@/kit/states/LoadingState';

const titleOf = (e: unknown, fallback: string) => (e instanceof ApiError ? e.problem.title + (e.problem.detail ? ` ${e.problem.detail}` : '') : fallback);

function Row({ label, error, children, id }: { label: string; error?: string; children: ReactNode; id: string }) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {error ? <p role="alert" className="text-small text-destructive">{error}</p> : null}
    </div>
  );
}

/** ST3: VAT status (read-only, with its source), WHT types with dated rates (a rate is never edited: "change the rate" adds a dated row) and the tax codes (view only). */
export default function TaxSettingsPage() {
  return <Inner key={useCompanyEpoch()} />;
}

function Inner() {
  const t = useTranslations('settings.tax');
  const { me, isError: meFailed, error: meError, refetch: refetchMe } = useMe();
  const id = me?.activeCompanyId ?? '';
  const q = useQuery({ queryKey: [id, 'settings', 'tax'], queryFn: taxApi.get, enabled: !!id });
  if (meFailed && !me) return <ErrorState error={meError} onRetry={() => void refetchMe()} />;
  if (q.isError && !q.data) return isForbidden(q.error) ? <ForbiddenState permission="tax.settings.manage" detail={q.error instanceof ApiError ? q.error.problem.detail : undefined} /> : <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  if (!me || !q.data) return <LoadingState />;
  return (
    <div className="grid gap-4">
      <div><h1 className="text-title font-semibold">{t('title')}</h1><p className="text-body text-muted-foreground">{t('lead')}</p></div>
      <Vat view={q.data} />
      <WhtTypes view={q.data} />
      <TaxCodes view={q.data} />
    </div>
  );
}

// ------------------------------------------------------------------ VAT (read-only + a dated request)

function Vat({ view }: { view: TaxSettings }) {
  const t = useTranslations('settings.tax.vat');
  const qc = useQueryClient();
  const { me } = useMe();
  const [date, setDate] = useState('');
  const [error, setError] = useState<string>();
  const want = !view.vat.registered; // the only change that exists: to the other status
  const send = useMutation({
    mutationFn: () => taxApi.requestVat({ register: want, effectiveFrom: date }),
    onSuccess: () => { setDate(''); setError(undefined); return qc.invalidateQueries({ queryKey: [me?.activeCompanyId ?? '', 'settings', 'tax'] }); },
    onError: (e) => setError(titleOf(e, t('failed'))),
  });
  const pending = view.vat.requests.filter((r) => r.status === 'pending');
  return (
    <section aria-labelledby="tax-vat" className="grid gap-3 rounded-lg border bg-card p-4">
      <div><h2 id="tax-vat" className="text-section font-semibold">{t('title')}</h2><p className="text-body text-muted-foreground">{t('lead')}</p></div>
      <dl className="grid gap-1 text-body sm:grid-cols-[12rem_minmax(0,1fr)]">
        <dt className="text-muted-foreground">{t('status')}</dt><dd>{view.vat.registered ? t('registered') : t('notRegistered')}</dd>
        <dt className="text-muted-foreground">{t('rate')}</dt><dd>{view.vat.rate}</dd>
        <dt className="text-muted-foreground">{t('source')}</dt><dd>{view.vat.source}</dd>
      </dl>
      {pending.length > 0 ? (
        <ul className="grid gap-1" aria-label={t('requests')}>
          {pending.map((r) => <li key={r.id} className="flex flex-wrap items-center gap-2 text-body"><Badge variant="outline">{t('pending')}</Badge>{t(r.register ? 'requestRegister' : 'requestDeregister', { date: r.effectiveFrom })}<span className="text-small text-muted-foreground">{t('by', { name: r.requestedBy })}</span></li>)}
        </ul>
      ) : (
        <form noValidate className="grid gap-2 sm:grid-cols-[14rem_auto] sm:items-end" onSubmit={(e) => { e.preventDefault(); setError(undefined); send.mutate(); }}>
          <Row id="vat-date" label={t(want ? 'dateRegister' : 'dateDeregister')}><Input id="vat-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Row>
          <div><Button type="submit" variant="outline" disabled={!date || send.isPending}>{t(want ? 'requestRegisterButton' : 'requestDeregisterButton')}</Button></div>
          {error ? <Alert variant="destructive" role="alert" className="sm:col-span-2"><AlertTitle>{error}</AlertTitle></Alert> : null}
        </form>
      )}
      <p className="text-small text-muted-foreground">{t('requestNote')}</p>
    </section>
  );
}

// ------------------------------------------------------------------ WHT types

/** Every dated row of one type, newest first; the row in force today is marked. A rate here is history, never an input. */
function RateHistory({ type }: { type: WhtTypeSetting }) {
  const t = useTranslations('settings.tax.wht');
  const rows: WhtRateRow[] = [...type.rows].reverse();
  return (
    <Table aria-label={t('historyOf', { name: type.nameTh })}>
      <TableHeader><TableRow><TableHead>{t('from')}</TableHead><TableHead>{t('rate')}</TableHead></TableRow></TableHeader>
      <TableBody>{rows.map((r) => <TableRow key={r.effectiveFrom}><TableCell className="tabular-nums">{r.effectiveFrom}</TableCell><TableCell className="tabular-nums">{r.rate}</TableCell></TableRow>)}</TableBody>
    </Table>
  );
}

function WhtTypes({ view }: { view: TaxSettings }) {
  const t = useTranslations('settings.tax.wht');
  const qc = useQueryClient();
  const { me } = useMe();
  const [change, setChange] = useState<WhtTypeSetting>();
  const [open, setOpen] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const refresh = () => qc.invalidateQueries({ queryKey: [me?.activeCompanyId ?? '', 'settings', 'tax'] });
  const toggle = useMutation({
    mutationFn: (x: WhtTypeSetting) => taxApi.setActive(x.code, { active: !x.active, version: x.version }),
    onMutate: () => setNotice(undefined), onSuccess: refresh, onError: (e) => { setNotice(titleOf(e, t('failed'))); void refresh(); },
  });
  return (
    <section aria-labelledby="tax-wht" className="grid gap-3 rounded-lg border bg-card p-4">
      <div><h2 id="tax-wht" className="text-section font-semibold">{t('title')}</h2><p className="text-body text-muted-foreground">{t('lead')}</p></div>
      {notice ? <Alert variant="destructive" role="alert"><AlertTitle>{notice}</AlertTitle></Alert> : null}
      <div className="overflow-x-auto">
        <Table>
          <TableHeader><TableRow>{(['code', 'name', 'income', 'rate', 'status', 'actions'] as const).map((c) => <TableHead key={c}>{t(`col.${c}`)}</TableHead>)}</TableRow></TableHeader>
          <TableBody>
            {view.whtTypes.map((x) => (
              <Fragment key={x.code}>
                <TableRow className={x.active ? undefined : 'text-muted-foreground'}>
                  <TableCell>{x.code}</TableCell><TableCell>{x.nameTh}</TableCell><TableCell>{x.incomeType}</TableCell><TableCell className="tabular-nums">{x.rate}</TableCell>
                  <TableCell>{x.active ? t('active') : <Badge variant="outline">{t('inactive')}</Badge>}</TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      <Button size="sm" variant="outline" aria-label={t('changeOf', { name: x.nameTh })} onClick={() => setChange(x)}>{t('change')}</Button>
                      <Button size="sm" variant="outline" aria-expanded={open === x.code} aria-label={t('historyButtonOf', { name: x.nameTh })} onClick={() => setOpen(open === x.code ? undefined : x.code)}>{t('history')}</Button>
                      <Button size="sm" variant="outline" disabled={toggle.isPending} aria-label={t(x.active ? 'deactivateOf' : 'activateOf', { name: x.nameTh })} onClick={() => toggle.mutate(x)}>{t(x.active ? 'deactivate' : 'activate')}</Button>
                    </div>
                  </TableCell>
                </TableRow>
                {open === x.code ? <TableRow><TableCell colSpan={6}><RateHistory type={x} /></TableCell></TableRow> : null}
              </Fragment>
            ))}
          </TableBody>
        </Table>
      </div>
      <p className="text-small text-muted-foreground">{t('freeze')}</p>
      {change ? <ChangeRate type={change} onClose={() => setChange(undefined)} onDone={() => { setChange(undefined); void refresh(); }} /> : null}
    </section>
  );
}

function ChangeRate({ type, onClose, onDone }: { type: WhtTypeSetting; onClose: () => void; onDone: () => void }) {
  const t = useTranslations('settings.tax.wht.form');
  const tc = useTranslations('settings.common');
  const [rate, setRate] = useState('');
  const [date, setDate] = useState('');
  const [errors, setErrors] = useState<{ rate?: string; date?: string; form?: string }>({});
  const save = useMutation({
    mutationFn: () => taxApi.changeRate(type.code, { rateBp: Math.round(Number(rate) * 100), ...(date ? { effectiveFrom: date } : {}), version: type.version }),
    onSuccess: onDone,
    onError: (e) => setErrors(e instanceof ApiError && e.problem.code === 'tax.rate_before_first' ? { date: e.problem.title } : { form: titleOf(e, tc('failed')) }),
  });
  const submit = () => {
    const n = Number(rate);
    if (!rate.trim() || !Number.isFinite(n) || n < 0 || n > 100) { setErrors({ rate: t('rateInvalid') }); return; }
    setErrors({}); save.mutate();
  };
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent aria-describedby={undefined} className="sm:max-w-md">
        <DialogHeader><DialogTitle>{t('title', { name: type.nameTh })}</DialogTitle></DialogHeader>
        <form noValidate className="grid gap-3" onSubmit={(e) => { e.preventDefault(); submit(); }}>
          {errors.form ? <Alert variant="destructive" role="alert"><AlertTitle>{errors.form}</AlertTitle></Alert> : null}
          <p className="text-body text-muted-foreground">{t('current', { rate: type.rate })}</p>
          <Row id="wr-rate" label={t('newRate')} error={errors.rate}><Input id="wr-rate" inputMode="decimal" value={rate} autoComplete="off" onChange={(e) => setRate(e.target.value)} aria-invalid={!!errors.rate} /></Row>
          <Row id="wr-date" label={t('from')} error={errors.date}><Input id="wr-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-invalid={!!errors.date} /><p className="text-small text-muted-foreground">{t('fromHint')}</p></Row>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>{tc('cancel')}</Button>
            <Button type="submit" disabled={save.isPending}>{save.isPending ? tc('saving') : tc('save')}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ------------------------------------------------------------------ tax codes (view only)

function TaxCodes({ view }: { view: TaxSettings }) {
  const t = useTranslations('settings.tax.codes');
  return (
    <section aria-labelledby="tax-codes" className="grid gap-3 rounded-lg border bg-card p-4">
      <div><h2 id="tax-codes" className="text-section font-semibold">{t('title')}</h2><p className="text-body text-muted-foreground">{t('lead')}</p></div>
      <Table>
        <TableHeader><TableRow>{(['code', 'name', 'rate'] as const).map((c) => <TableHead key={c}>{t(`col.${c}`)}</TableHead>)}</TableRow></TableHeader>
        <TableBody>{view.taxCodes.map((c) => <TableRow key={c.code}><TableCell>{c.code}</TableCell><TableCell>{c.nameTh}</TableCell><TableCell className="tabular-nums">{c.rate}</TableCell></TableRow>)}</TableBody>
      </Table>
    </section>
  );
}

