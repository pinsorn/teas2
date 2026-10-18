'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState, type ReactNode } from 'react';
import { Alert, AlertTitle } from '@/components/ui/alert';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useCompanyEpoch } from '@/app-shell/useCompanyEpoch';
import { isForbidden, useMe } from '@/app-shell/useMe';
import { ApiError } from '@/lib/api/client';
import { type AccountRuleRow, type DimensionRule, type DimensionTypeRow, type DimensionsView, dimensionApi } from '@/records/dimensions';
import { EmptyState } from '@/kit/states/EmptyState';
import { ErrorState } from '@/kit/states/ErrorState';
import { ForbiddenState } from '@/kit/states/ForbiddenState';
import { LoadingState } from '@/kit/states/LoadingState';

const select = 'h-(--ctl-h) w-full rounded-lg border border-input bg-card px-2 text-body outline-none';
type FieldErrors = Record<string, string[]>;
const fieldErrorsOf = (e: unknown): FieldErrors => (e instanceof ApiError ? e.problem.fieldErrors ?? {} : {});
const titleOf = (e: unknown, fallback: string) => (e instanceof ApiError ? e.problem.title + (e.problem.detail ? ` ${e.problem.detail}` : '') : fallback);
const RULES: DimensionRule[] = ['optional', 'required', 'forbidden'];

function Row({ label, error, children, id }: { label: string; error?: string; children: ReactNode; id: string }) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {error ? <p role="alert" className="text-small text-destructive">{error}</p> : null}
    </div>
  );
}

/** ST2: the dimension types (at most four) with their values, and what each account demands of them. A tag on a document is the type's key and the value's code; nothing here rewrites a document that already carries one. */
export default function DimensionsPage() {
  return <Inner key={useCompanyEpoch()} />;
}

function Inner() {
  const t = useTranslations('settings.dimensions');
  const { me, isError: meFailed, error: meError, refetch: refetchMe } = useMe();
  const id = me?.activeCompanyId ?? '';
  const dims = useQuery({ queryKey: [id, 'dimensions'], queryFn: dimensionApi.list, enabled: !!id });
  const rules = useQuery({ queryKey: [id, 'settings', 'dimension-rules'], queryFn: dimensionApi.accountRules, enabled: !!id }); // settings.manage: it decides the gate
  if (meFailed && !me) return <ErrorState error={meError} onRetry={() => void refetchMe()} />;
  const bad = rules.isError && !rules.data ? rules : dims.isError && !dims.data ? dims : undefined;
  if (bad) return isForbidden(bad.error) ? <ForbiddenState permission="settings.manage" detail={bad.error instanceof ApiError ? bad.error.problem.detail : undefined} /> : <ErrorState error={bad.error} onRetry={() => void bad.refetch()} />;
  if (!me || !dims.data || !rules.data) return <LoadingState />;
  return (
    <div className="grid gap-4">
      <div><h1 className="text-title font-semibold">{t('title')}</h1><p className="text-body text-muted-foreground">{t('lead')}</p></div>
      <Types view={dims.data} />
      <AccountRules view={dims.data} rows={rules.data.items} />
    </div>
  );
}

// ------------------------------------------------------------------ types and values

function Types({ view }: { view: DimensionsView }) {
  const t = useTranslations('settings.dimensions');
  const qc = useQueryClient();
  const { me } = useMe();
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: [me?.activeCompanyId ?? '', 'dimensions'] }), qc.invalidateQueries({ queryKey: [me?.activeCompanyId ?? '', 'settings', 'dimension-rules'] })]);
  const [typeForm, setTypeForm] = useState<{ row?: DimensionTypeRow } | undefined>();
  const [confirm, setConfirm] = useState<{ kind: 'type'; row: DimensionTypeRow } | { kind: 'value'; type: DimensionTypeRow; code: string; version: number; name: string }>();
  const [notice, setNotice] = useState<string>();
  const run = useMutation({ mutationFn: (f: () => Promise<unknown>) => f(), onMutate: () => setNotice(undefined), onSuccess: refresh, onError: (e) => setNotice(titleOf(e, t('title'))) });
  return (
    <section aria-labelledby="dim-types" className="grid gap-3 rounded-lg border bg-card p-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div><h2 id="dim-types" className="text-section font-semibold">{t('types.title')}</h2><p className="text-body text-muted-foreground">{t('types.lead', { n: view.types.length, max: view.maxTypes })}</p></div>
        <Button onClick={() => setTypeForm({})}>{t('types.add')}</Button>
      </div>
      {notice ? <Alert variant="destructive" role="alert"><AlertTitle>{notice}</AlertTitle></Alert> : null}
      {view.types.length === 0 ? <EmptyState title={t('types.empty')} /> : view.types.map((ty) => (
        <div key={ty.key} role="group" aria-label={ty.nameTh} className="grid gap-2 rounded-lg border p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-body font-semibold">{ty.nameTh} <span className="text-small font-normal text-muted-foreground">({ty.key})</span></h3>
            <div className="flex gap-1">
              <Button size="sm" variant="outline" aria-label={t('types.renameOf', { name: ty.nameTh })} onClick={() => setTypeForm({ row: ty })}>{t('types.rename')}</Button>
              <Button size="sm" variant="outline" aria-label={t('types.deleteOf', { name: ty.nameTh })} onClick={() => setConfirm({ kind: 'type', row: ty })}>{t('delete')}</Button>
            </div>
          </div>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader><TableRow>{(['code', 'name', 'status', 'actions'] as const).map((c) => <TableHead key={c}>{t(`values.${c}`)}</TableHead>)}</TableRow></TableHeader>
              <TableBody>
                {ty.values.map((v) => (
                  <TableRow key={v.code} className={v.active ? undefined : 'text-muted-foreground'}>
                    <TableCell>{v.code}</TableCell><TableCell>{v.nameTh}</TableCell>
                    <TableCell>{v.active ? t('values.active') : <Badge variant="outline">{t('values.inactive')}</Badge>}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        <Button size="sm" variant="outline" aria-label={t(v.active ? 'values.deactivateOf' : 'values.activateOf', { name: `${ty.nameTh} ${v.code}` })}
                          onClick={() => run.mutate(() => dimensionApi.updateValue(ty.key, v.code, { active: !v.active, version: v.version }))}>{t(v.active ? 'values.deactivate' : 'values.activate')}</Button>
                        <Button size="sm" variant="outline" aria-label={t('values.deleteOf', { name: `${ty.nameTh} ${v.code}` })} onClick={() => setConfirm({ kind: 'value', type: ty, code: v.code, version: v.version, name: `${ty.nameTh} ${v.code}` })}>{t('delete')}</Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <NewValue type={ty} onAdd={(body) => dimensionApi.createValue(ty.key, body).then(refresh)} />
        </div>
      ))}
      {typeForm ? <TypeForm row={typeForm.row} onClose={() => setTypeForm(undefined)} onDone={() => { setTypeForm(undefined); void refresh(); }} /> : null}
      <AlertDialog open={!!confirm} onOpenChange={(o) => { if (!o) setConfirm(undefined); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('deleteTitle', { name: confirm?.kind === 'type' ? confirm.row.nameTh : confirm?.name ?? '' })}</AlertDialogTitle>
            <AlertDialogDescription>{t('deleteBody')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={() => { const c = confirm!; setConfirm(undefined); run.mutate(() => (c.kind === 'type' ? dimensionApi.removeType(c.row.key, c.row.version) : dimensionApi.removeValue(c.type.key, c.code, c.version))); }}>{t('delete')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

function NewValue({ type, onAdd }: { type: DimensionTypeRow; onAdd: (body: { code: string; nameTh: string }) => Promise<unknown> }) {
  const t = useTranslations('settings.dimensions.values');
  const [v, setV] = useState({ code: '', nameTh: '' });
  const [errors, setErrors] = useState<FieldErrors>({});
  const [failed, setFailed] = useState<string>();
  const add = useMutation({ mutationFn: () => onAdd(v), onSuccess: () => { setV({ code: '', nameTh: '' }); setErrors({}); setFailed(undefined); }, onError: (e) => { setErrors(fieldErrorsOf(e)); setFailed(titleOf(e, t('failed'))); } });
  return (
    <form noValidate className="grid gap-2 sm:grid-cols-[10rem_minmax(0,1fr)_auto] sm:items-start" onSubmit={(e) => { e.preventDefault(); setErrors({}); setFailed(undefined); add.mutate(); }}>
      <Row id={`nv-${type.key}-code`} label={t('newCode', { name: type.nameTh })} error={errors.code?.[0]}><Input id={`nv-${type.key}-code`} value={v.code} autoComplete="off" onChange={(e) => setV({ ...v, code: e.target.value })} aria-invalid={!!errors.code} /></Row>
      <Row id={`nv-${type.key}-name`} label={t('newName', { name: type.nameTh })} error={errors.nameTh?.[0]}><Input id={`nv-${type.key}-name`} value={v.nameTh} autoComplete="off" onChange={(e) => setV({ ...v, nameTh: e.target.value })} aria-invalid={!!errors.nameTh} /></Row>
      <div className="sm:pt-6"><Button type="submit" variant="outline" disabled={add.isPending}>{t('add', { name: type.nameTh })}</Button></div>
      {failed && !errors.code && !errors.nameTh ? <Alert variant="destructive" role="alert" className="sm:col-span-3"><AlertTitle>{failed}</AlertTitle></Alert> : null}
    </form>
  );
}

function TypeForm({ row, onClose, onDone }: { row?: DimensionTypeRow; onClose: () => void; onDone: () => void }) {
  const t = useTranslations('settings.dimensions.types');
  const tc = useTranslations('settings.common');
  const [v, setV] = useState({ key: row?.key ?? '', nameTh: row?.nameTh ?? '' });
  const [errors, setErrors] = useState<FieldErrors>({});
  const [failed, setFailed] = useState<string>();
  const save = useMutation({
    mutationFn: () => (row ? dimensionApi.updateType(row.key, { nameTh: v.nameTh, version: row.version }) : dimensionApi.createType(v)),
    onSuccess: onDone,
    onError: (e) => { setErrors(fieldErrorsOf(e)); setFailed(titleOf(e, tc('failed'))); },
  });
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent aria-describedby={undefined} className="sm:max-w-md">
        <DialogHeader><DialogTitle>{row ? t('renameTitle', { name: row.nameTh }) : t('addTitle')}</DialogTitle></DialogHeader>
        <form noValidate className="grid gap-3" onSubmit={(e) => { e.preventDefault(); setErrors({}); setFailed(undefined); save.mutate(); }}>
          {failed ? <Alert variant="destructive" role="alert"><AlertTitle>{failed}</AlertTitle></Alert> : null}
          <Row id="dt-name" label={t('name')} error={errors.nameTh?.[0]}><Input id="dt-name" value={v.nameTh} autoComplete="off" onChange={(e) => setV({ ...v, nameTh: e.target.value })} aria-invalid={!!errors.nameTh} /></Row>
          <Row id="dt-key" label={t('key')} error={errors.key?.[0]}><Input id="dt-key" value={v.key} readOnly={!!row} autoComplete="off" onChange={(e) => setV({ ...v, key: e.target.value })} aria-invalid={!!errors.key} /><p className="text-small text-muted-foreground">{t('keyHint')}</p></Row>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>{tc('cancel')}</Button>
            <Button type="submit" disabled={save.isPending}>{save.isPending ? tc('saving') : tc('save')}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ------------------------------------------------------------------ account rules

/** Per account and type: optional (nothing), required or forbidden. A change is one audited save and applies to the next documents - issued ones stay as they are. */
function AccountRules({ view, rows }: { view: DimensionsView; rows: AccountRuleRow[] }) {
  const t = useTranslations('settings.dimensions.rules');
  const qc = useQueryClient();
  const { me } = useMe();
  const [q, setQ] = useState('');
  const [only, setOnly] = useState(false);
  const [notice, setNotice] = useState<string>();
  const save = useMutation({
    mutationFn: (p: { row: AccountRuleRow; type: string; rule: DimensionRule }) => dimensionApi.setAccountRules(p.row.code, { rules: { ...p.row.rules, [p.type]: p.rule }, version: p.row.version }),
    onMutate: () => setNotice(undefined),
    onSettled: () => qc.invalidateQueries({ queryKey: [me?.activeCompanyId ?? '', 'settings', 'dimension-rules'] }),
    onError: (e) => setNotice(titleOf(e, t('failed'))),
  });
  const needle = q.trim().toLowerCase();
  const shown = rows.filter((r) => (!only || Object.keys(r.rules).length > 0) && (!needle || `${r.code} ${r.nameTh}`.toLowerCase().includes(needle)));
  return (
    <section aria-labelledby="dim-rules" className="grid gap-3 rounded-lg border bg-card p-4">
      <div><h2 id="dim-rules" className="text-section font-semibold">{t('title')}</h2><p className="text-body text-muted-foreground">{t('lead')}</p></div>
      {view.types.length === 0 ? <EmptyState title={t('noTypes')} /> : (
        <>
          <div className="flex flex-wrap items-end gap-3">
            <div className="grid gap-1.5"><Label htmlFor="rule-q">{t('search')}</Label><Input id="rule-q" value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" className="sm:w-64" /></div>
            <div className="flex items-center gap-2 pb-2"><Checkbox id="rule-only" checked={only} onCheckedChange={(c) => setOnly(c === true)} /><Label htmlFor="rule-only">{t('onlyWithRules')}</Label></div>
          </div>
          {notice ? <Alert variant="destructive" role="alert"><AlertTitle>{notice}</AlertTitle></Alert> : null}
          <div className="max-h-[32rem] overflow-auto rounded-lg border">
            <Table>
              <TableHeader><TableRow><TableHead>{t('account')}</TableHead>{view.types.map((ty) => <TableHead key={ty.key}>{ty.nameTh}</TableHead>)}</TableRow></TableHeader>
              <TableBody>
                {shown.map((r) => (
                  <TableRow key={r.code}>
                    <TableCell className="tabular-nums">{r.code} {r.nameTh}</TableCell>
                    {view.types.map((ty) => (
                      <TableCell key={ty.key}>
                        <select className={select} aria-label={t('cell', { account: `${r.code} ${r.nameTh}`, type: ty.nameTh })} value={r.rules[ty.key] ?? 'optional'} disabled={save.isPending}
                          onChange={(e) => save.mutate({ row: r, type: ty.key, rule: e.target.value as DimensionRule })}>
                          {RULES.map((x) => <option key={x} value={x}>{t(`rule.${x}`)}</option>)}
                        </select>
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          {shown.length === 0 ? <EmptyState title={t('none')} /> : null}
        </>
      )}
    </section>
  );
}
