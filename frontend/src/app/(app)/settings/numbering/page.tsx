'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState, type ReactNode } from 'react';
import { Alert, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useCompanyEpoch } from '@/app-shell/useCompanyEpoch';
import { isForbidden, useMe } from '@/app-shell/useMe';
import { ApiError } from '@/lib/api/client';
import { type NumberingBody, type NumberingRow, type NumberingScope, numberingApi } from '@/records/tax-numbering-approvals';
import { ErrorState } from '@/kit/states/ErrorState';
import { ForbiddenState } from '@/kit/states/ForbiddenState';
import { LoadingState } from '@/kit/states/LoadingState';

const select = 'h-(--ctl-h) w-full rounded-lg border border-input bg-card px-2 text-body outline-none';
const titleOf = (e: unknown, fallback: string) => (e instanceof ApiError ? e.problem.title + (e.problem.detail ? ` ${e.problem.detail}` : '') : fallback);
const TOKENS = ['{PREFIX}', '{BRANCH}', '{YYYY}', '{YY}', '{MM}', '{####}'];

function Row({ label, children, id }: { label: string; children: ReactNode; id: string }) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
    </div>
  );
}

/** ST3: per document type the prefix, scope, branch and format of its numbers. A key (type x period) keeps the format of its first number: a change applies from the first period without numbers. */
export default function NumberingSettingsPage() {
  return <Inner key={useCompanyEpoch()} />;
}

function Inner() {
  const t = useTranslations('settings.numbering');
  const td = useTranslations('docTypes');
  const qc = useQueryClient();
  const { me, isError: meFailed, error: meError, refetch: refetchMe } = useMe();
  const id = me?.activeCompanyId ?? '';
  const q = useQuery({ queryKey: [id, 'settings', 'numbering'], queryFn: numberingApi.list, enabled: !!id });
  const [edit, setEdit] = useState<NumberingRow>();
  const [notice, setNotice] = useState<string>();
  if (meFailed && !me) return <ErrorState error={meError} onRetry={() => void refetchMe()} />;
  if (q.isError && !q.data) return isForbidden(q.error) ? <ForbiddenState permission="settings.manage" detail={q.error instanceof ApiError ? q.error.problem.detail : undefined} /> : <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  if (!me || !q.data) return <LoadingState />;
  const name = (type: string) => td(`${type}.title`);
  return (
    <div className="grid gap-4">
      <div><h1 className="text-title font-semibold">{t('title')}</h1><p className="text-body text-muted-foreground">{t('lead')}</p></div>
      {notice ? <Alert role="status" data-testid="numbering-notice"><AlertTitle>{notice}</AlertTitle></Alert> : null}
      <section aria-label={t('table')} className="min-w-0 rounded-lg border bg-card p-4">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader><TableRow>{(['type', 'prefix', 'scope', 'format', 'next', 'actions'] as const).map((c) => <TableHead key={c}>{t(`col.${c}`)}</TableHead>)}</TableRow></TableHeader>
            <TableBody>
              {q.data.items.map((r) => (
                <TableRow key={r.docType}>
                  <TableCell>{name(r.docType)} <span className="text-small text-muted-foreground">({r.docType})</span></TableCell>
                  <TableCell>{r.prefix}{r.branch ? <span className="text-small text-muted-foreground"> · {r.branch}</span> : null}</TableCell>
                  <TableCell>{t(`scope.${r.scope}`)}</TableCell>
                  <TableCell className="font-mono text-small">{r.format}</TableCell>
                  <TableCell className="tabular-nums">{r.next}</TableCell>
                  <TableCell><Button size="sm" variant="outline" aria-label={t('editOf', { name: name(r.docType) })} onClick={() => { setNotice(undefined); setEdit(r); }}>{t('edit')}</Button></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <p className="mt-3 text-small text-muted-foreground">{t('frozen')}</p>
      </section>
      {edit ? <Form row={edit} name={name(edit.docType)} onClose={() => setEdit(undefined)} onDone={(saved) => { setEdit(undefined); setNotice(saved.notice?.title); void qc.invalidateQueries({ queryKey: [id, 'settings', 'numbering'] }); }} /> : null}
    </div>
  );
}

/** What the server would number first under this config (its own formatting; the client never formats a number). */
function NumberFormatPreview({ docType, body }: { docType: string; body: NumberingBody }) {
  const t = useTranslations('settings.numbering.preview');
  const { me } = useMe();
  const p = useQuery({ queryKey: [me?.activeCompanyId ?? '', 'settings', 'numbering-preview', docType, body], queryFn: () => numberingApi.preview(docType, body), enabled: !!body.format.trim() && !!body.prefix.trim(), retry: false });
  return (
    <div className="grid gap-1 rounded-lg border bg-muted/40 p-3" aria-live="polite" data-testid="number-preview">
      <span className="text-small text-muted-foreground">{t('label')}</span>
      {p.isError ? <p role="alert" className="text-body text-destructive">{titleOf(p.error, t('failed'))}</p>
        : p.data ? <><p className="text-section font-semibold tabular-nums" data-testid="number-preview-value">{p.data.next}</p><p className="text-small text-muted-foreground">{p.data.inUse ? t('fromNext', { period: p.data.period }) : t('fromNow', { period: p.data.period })}</p></>
        : <p className="text-body text-muted-foreground">{t('wait')}</p>}
    </div>
  );
}

function Form({ row, name, onClose, onDone }: { row: NumberingRow; name: string; onClose: () => void; onDone: (saved: NumberingRow) => void }) {
  const t = useTranslations('settings.numbering.form');
  const tc = useTranslations('settings.common');
  const [v, setV] = useState<{ prefix: string; scope: NumberingScope; branch: string; format: string }>({ prefix: row.prefix, scope: row.scope, branch: row.branch ?? '', format: row.format });
  const [failed, setFailed] = useState<string>();
  const body: NumberingBody = { prefix: v.prefix.trim(), scope: v.scope, format: v.format.trim(), ...(v.branch.trim() ? { branch: v.branch.trim() } : {}) };
  const save = useMutation({ mutationFn: () => numberingApi.save(row.docType, { ...body, version: row.version }), onSuccess: onDone, onError: (e) => setFailed(titleOf(e, tc('failed'))) });
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent aria-describedby={undefined} className="sm:max-w-lg">
        <DialogHeader><DialogTitle>{t('title', { name })}</DialogTitle></DialogHeader>
        <form noValidate className="grid gap-3" onSubmit={(e) => { e.preventDefault(); setFailed(undefined); save.mutate(); }}>
          {failed ? <Alert variant="destructive" role="alert"><AlertTitle>{failed}</AlertTitle></Alert> : null}
          <div className="grid gap-3 sm:grid-cols-2">
            <Row id="nm-prefix" label={t('prefix')}><Input id="nm-prefix" value={v.prefix} autoComplete="off" onChange={(e) => setV({ ...v, prefix: e.target.value })} /></Row>
            <Row id="nm-scope" label={t('scope')}>
              <select id="nm-scope" className={select} value={v.scope} onChange={(e) => setV({ ...v, scope: e.target.value as NumberingScope })}>
                <option value="monthly">{t('monthly')}</option><option value="yearly">{t('yearly')}</option>
              </select>
            </Row>
          </div>
          <Row id="nm-branch" label={t('branch')}><Input id="nm-branch" value={v.branch} autoComplete="off" onChange={(e) => setV({ ...v, branch: e.target.value })} /></Row>
          <Row id="nm-format" label={t('format')}>
            <Input id="nm-format" value={v.format} autoComplete="off" spellCheck={false} className="font-mono" onChange={(e) => setV({ ...v, format: e.target.value })} />
            <p className="text-small text-muted-foreground">{t('tokens', { list: TOKENS.join(' ') })}</p>
            <p className="text-small text-muted-foreground">{t(v.scope === 'monthly' ? 'ruleMonthly' : 'ruleYearly', { mm: '{MM}', yyyy: '{YYYY}', yy: '{YY}', counter: '{####}' })}</p>
          </Row>
          <NumberFormatPreview docType={row.docType} body={body} />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>{tc('cancel')}</Button>
            <Button type="submit" disabled={save.isPending}>{save.isPending ? tc('saving') : tc('save')}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
