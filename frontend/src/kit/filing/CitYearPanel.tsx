'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { useMe } from '@/app-shell/useMe';
import { Alert, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { CitAdjustment, CitLoss, CitYearView } from '@/domain/filings';
import { ApiError } from '@/lib/api/client';
import { endpoints } from '@/lib/api/endpoints';
import { formatMoney } from '@/lib/format';
import { qk } from '@/lib/query/keys';

const selectCls = 'h-(--ctl-h) rounded-lg border border-input bg-card px-3 text-body';

/** TX3a: the year data of the corporate income tax (paid-up capital, prior-year losses, the ภ.ง.ด.51 estimate) and the user's tax adjustments (ม.65 ทวิ / ตรี). The server holds every rule: this lays out what it says and sends edits;
 *  the SME flag and the profit are read from the server. Editing needs tax.filing.finalize; a filed return locks what it read (the server refuses, the form shows why). Renders nothing while loading / on an error: the FilingView beside it owns those states. */
export function CitYearPanel({ year, tab }: { year: string; tab: 'pnd50' | 'pnd51' }) {
  const { me } = useMe();
  const company = me?.activeCompanyId ?? '';
  const q = useQuery({ queryKey: qk.citYear(company, year), queryFn: () => endpoints.getCitYear(year), enabled: !!company && /^\d{4}$/.test(year) });
  if (!q.data) return null;
  return <Panel key={`${company}-${year}-${JSON.stringify(q.data)}`} year={year} tab={tab} v={q.data} canEdit={!!me?.permissions.includes('tax.filing.finalize')} company={company} />;
}

function Panel({ year, tab, v, canEdit, company }: { year: string; tab: 'pnd50' | 'pnd51'; v: CitYearView; canEdit: boolean; company: string }) {
  const t = useTranslations('cit');
  const qc = useQueryClient();
  const [capital, setCapital] = useState(v.paidUpCapital);
  const [losses, setLosses] = useState<CitLoss[]>(v.losses);
  const [mode, setMode] = useState<'h1x2' | 'input'>(v.estimate?.mode ?? 'h1x2');
  const [estimate, setEstimate] = useState(v.estimate?.netProfit ?? '');
  const refresh = async () => { await qc.invalidateQueries({ queryKey: [company, 'filings'] }); };
  const save = useMutation({
    mutationFn: () => endpoints.putCitYear(year, {
      ...(capital !== v.paidUpCapital ? { paidUpCapital: capital } : {}), ...(JSON.stringify(losses) !== JSON.stringify(v.losses) ? { losses } : {}),
      ...(tab === 'pnd51' && (mode !== (v.estimate?.mode ?? 'h1x2') || (mode === 'input' && estimate !== (v.estimate?.netProfit ?? ''))) ? { estimate: mode === 'h1x2' ? { mode } : { mode, netProfit: estimate } } : {}),
    }),
    onSuccess: refresh,
  });
  const lockedAll = v.pnd50Filed, lockedEstimate = v.pnd51Filed || v.pnd50Filed, edit = canEdit && !lockedAll;
  const err = (m: { error: unknown }) => (m.error ? <Alert variant="destructive" role="alert"><AlertTitle>{m.error instanceof ApiError ? m.error.problem.title : 'error'}</AlertTitle></Alert> : null);
  return (
    <section aria-label={t('data.title')} className="grid gap-4 rounded-lg border bg-card p-4 print:hidden" data-testid="cit-year-panel">
      <h2 className="text-section font-semibold">{t('data.title')}</h2>
      <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-body sm:max-w-md">
        <dt className="text-muted-foreground">{t('data.revenue')}</dt><dd className="text-right tabular-nums">{formatMoney(v.revenue)}</dd>
        <dt className="text-muted-foreground">{t('data.netProfit')}</dt><dd className="text-right tabular-nums" data-testid="cit-net-profit">{formatMoney(v.netProfit)}</dd>
        <dt className="text-muted-foreground">{t('data.sme')}</dt><dd className="text-right" data-testid="cit-sme">{v.sme ? t('data.smeYes') : t('data.smeNo')}</dd>
        <dt className="text-muted-foreground">{t('data.yearClosed')}</dt><dd className="text-right">{v.yearClosed ? t('data.yearClosed') : t('data.yearOpen')}</dd>
      </dl>
      {lockedAll ? <p className="text-small text-muted-foreground" data-testid="cit-locked">{t('data.locked')}</p> : v.pnd51Filed ? <p className="text-small text-muted-foreground">{t('data.estimateLocked')}</p> : null}
      <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <div className="grid gap-1.5 sm:max-w-xs">
          <Label htmlFor="cit-capital">{t('data.paidUp')}</Label>
          <Input id="cit-capital" inputMode="decimal" value={capital} onChange={(e) => setCapital(e.target.value)} disabled={!edit || lockedEstimate} className="text-end" />
        </div>
        <fieldset className="grid gap-2" disabled={!edit}>
          <legend className="font-semibold">{t('losses.title')}</legend>
          <p className="text-small text-muted-foreground">{t('losses.hint')}</p>
          {losses.map((l, i) => (
            <div key={i} className="flex flex-wrap items-end gap-2">
              <div className="grid gap-1.5"><Label htmlFor={`cit-ly-${i}`}>{t('losses.year')}</Label><Input id={`cit-ly-${i}`} inputMode="numeric" value={l.year} onChange={(e) => setLosses(losses.map((x, j) => (j === i ? { ...x, year: Number(e.target.value) || 0 } : x)))} className="w-28" /></div>
              <div className="grid gap-1.5"><Label htmlFor={`cit-la-${i}`}>{t('losses.amount')}</Label><Input id={`cit-la-${i}`} inputMode="decimal" value={l.amount} onChange={(e) => setLosses(losses.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} className="w-40 text-end" /></div>
              <Button type="button" variant="outline" onClick={() => setLosses(losses.filter((_, j) => j !== i))}>{t('losses.remove')}</Button>
            </div>
          ))}
          <div><Button type="button" variant="outline" onClick={() => setLosses([...losses, { year: Number(year) - 1, amount: '' }])}>{t('losses.add')}</Button></div>
        </fieldset>
        {tab === 'pnd51' ? (
          <fieldset className="grid gap-2" disabled={!edit || lockedEstimate}>
            <legend className="font-semibold">{t('estimate.title')}</legend>
            <div className="flex flex-wrap items-end gap-2">
              <div className="grid gap-1.5"><Label htmlFor="cit-mode">{t('estimate.mode')}</Label>
                <select id="cit-mode" className={selectCls} value={mode} onChange={(e) => setMode(e.target.value as 'h1x2' | 'input')}><option value="h1x2">{t('estimate.h1x2')}</option><option value="input">{t('estimate.input')}</option></select></div>
              {mode === 'input' ? <div className="grid gap-1.5"><Label htmlFor="cit-estimate">{t('estimate.amount')}</Label><Input id="cit-estimate" inputMode="decimal" value={estimate} onChange={(e) => setEstimate(e.target.value)} className="w-44 text-end" /></div> : null}
            </div>
          </fieldset>
        ) : null}
        {err(save)}
        {edit ? <div><Button type="submit" disabled={save.isPending}>{t('data.save')}</Button></div> : null}
      </form>
      {tab === 'pnd50' ? <Adjustments year={year} items={v.adjustments} edit={edit} refresh={refresh} /> : null}
    </section>
  );
}

function Adjustments({ year, items, edit, refresh }: { year: string; items: CitAdjustment[]; edit: boolean; refresh: () => Promise<void> }) {
  const t = useTranslations('cit.adj');
  const [id, setId] = useState<string | undefined>();
  const [open, setOpen] = useState(false);
  const [line, setLine] = useState(13);
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const done = async () => { setOpen(false); setId(undefined); setAmount(''); setReason(''); await refresh(); };
  const save = useMutation({ mutationFn: () => (id ? endpoints.updateCitAdjustment(year, id, { line, amount, reason }) : endpoints.addCitAdjustment(year, { line, amount, reason })), onSuccess: done });
  const del = useMutation({ mutationFn: (x: string) => endpoints.deleteCitAdjustment(year, x), onSuccess: refresh });
  const begin = (a?: CitAdjustment) => { save.reset(); setId(a?.id); setLine(a?.line ?? 13); setAmount(a?.amount ?? ''); setReason(a?.reason ?? ''); setOpen(true); };
  const problem = (e: unknown) => (e instanceof ApiError ? e.problem.title : e ? 'error' : undefined);
  return (
    <div className="grid gap-2" data-testid="cit-adjustments">
      <h3 className="font-semibold">{t('title')}</h3>
      <p className="text-small text-muted-foreground">{t('hint')}</p>
      {items.length === 0 ? <p className="text-muted-foreground">{t('empty')}</p> : (
        <div role="region" aria-label={t('title')} tabIndex={0} className="overflow-x-auto rounded-lg border [&_[data-slot=table-container]]:overflow-visible">
          <Table aria-label={t('title')}>
            <TableHeader><TableRow><TableHead>{t('line')}</TableHead><TableHead className="text-end">{t('amount')}</TableHead><TableHead>{t('reason')}</TableHead><TableHead>{t('by')}</TableHead><TableHead><span className="sr-only">{t('edit')}</span></TableHead></TableRow></TableHeader>
            <TableBody>
              {items.map((a) => (
                <TableRow key={a.id} className="h-(--row-h)" data-testid={`adj-${a.id}`}>
                  <TableCell>{a.line}</TableCell><TableCell className="text-end tabular-nums">{formatMoney(a.amount)}</TableCell><TableCell>{a.reason}</TableCell><TableCell>{a.by}</TableCell>
                  <TableCell>{edit ? <div className="flex gap-2"><Button variant="outline" size="sm" onClick={() => begin(a)}>{t('edit')}</Button><Button variant="outline" size="sm" disabled={del.isPending} onClick={() => del.mutate(a.id)}>{t('delete')}</Button></div> : null}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {problem(del.error) ? <Alert variant="destructive" role="alert"><AlertTitle>{problem(del.error)}</AlertTitle></Alert> : null}
      {edit && !open ? <div><Button variant="outline" onClick={() => begin()}>{t('add')}</Button></div> : null}
      {edit && open ? (
        <form className="grid gap-3 rounded-lg border p-3" onSubmit={(e) => { e.preventDefault(); save.mutate(); }} data-testid="cit-adj-form">
          <div className="flex flex-wrap items-end gap-2">
            <div className="grid gap-1.5"><Label htmlFor="adj-line">{t('line')}</Label>
              <select id="adj-line" className={selectCls} value={line} onChange={(e) => setLine(Number(e.target.value))}><option value={10}>{t('line10')}</option><option value={11}>{t('line11')}</option><option value={13}>{t('line13')}</option></select></div>
            <div className="grid gap-1.5"><Label htmlFor="adj-amount">{t('amount')}</Label><Input id="adj-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className="w-40 text-end" /></div>
          </div>
          <div className="grid gap-1.5"><Label htmlFor="adj-reason">{t('reason')} <span aria-hidden>*</span></Label><Input id="adj-reason" value={reason} onChange={(e) => setReason(e.target.value)} /></div>
          {problem(save.error) ? <Alert variant="destructive" role="alert"><AlertTitle>{problem(save.error)}</AlertTitle></Alert> : null}
          <div className="flex gap-2"><Button type="submit" disabled={save.isPending}>{t('save')}</Button><Button type="button" variant="outline" onClick={() => setOpen(false)}>{t('cancel')}</Button></div>
        </form>
      ) : null}
    </div>
  );
}
