'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { useCompanyEpoch } from '@/app-shell/useCompanyEpoch';
import { isForbidden, useMe } from '@/app-shell/useMe';
import type { DocType, PaperModel } from '@/domain/types';
import { ApiError, api } from '@/lib/api/client';
import { ErrorState } from '@/kit/states/ErrorState';
import { ForbiddenState } from '@/kit/states/ForbiddenState';
import { LoadingState } from '@/kit/states/LoadingState';
import { PAPERS } from '@/kit/paper/registry';

// SP1c ST4: the print options of each printable type. A toggle here is a display option read at print time (it hides an image or a line); it never changes a frozen figure or what an issued document snapshotted.
interface TemplateRow { type: DocType; showLogo: boolean; showStamp: boolean; showSignature: boolean; signatureLabels: string[]; issuerLine?: string; version: number }
interface TemplatesView { items: TemplateRow[]; labels: string[] }
const T = '/settings/templates';

/** ST4: the type's REAL paper (the print route's component) built by the server from a sample document - no second renderer. Re-fetched after every save (the key carries the version). */
function TemplatePreview({ type, version }: { type: DocType; version: number }) {
  const t = useTranslations('settings.templates.preview');
  const { me } = useMe();
  const q = useQuery({ queryKey: [me?.activeCompanyId ?? '', 'settings', 'templates', 'preview', type, version], queryFn: () => api<PaperModel>('GET', `${T}/${type}/preview`), enabled: !!me });
  const Paper = PAPERS[type];
  return (
    <section aria-labelledby="tpl-preview" className="grid gap-2 rounded-lg border bg-card p-4">
      <div><h2 id="tpl-preview" className="text-section font-semibold">{t('title')}</h2><p className="text-small text-muted-foreground">{t('note')}</p></div>
      {q.isError ? <p role="alert" className="text-small text-destructive">{t('failed')}</p> : !q.data || !Paper ? <p role="status" className="text-small text-muted-foreground">{t('loading')}</p>
        : <div className="overflow-x-auto" tabIndex={0} role="region" aria-label={t('title')} data-testid="template-preview"><Paper model={q.data} /></div>}
    </section>
  );
}

type Msg = { ok: boolean; text: string } | undefined;

// msg lives in the parent: a save bumps row.version, which remounts the Editor (key) and would drop the 'saved' / 'conflict' message with it.
function Editor({ row, labels, msg, setMsg }: { row: TemplateRow; labels: string[]; msg: Msg; setMsg: (m: Msg) => void }) {
  const t = useTranslations('settings.templates.editor');
  const td = useTranslations('docTypes');
  const qc = useQueryClient();
  const { me } = useMe();
  const [v, setV] = useState({ showLogo: row.showLogo, showStamp: row.showStamp, showSignature: row.showSignature, signatureLabels: row.signatureLabels });
  const name = td(`${row.type}.title`);
  const refresh = () => qc.invalidateQueries({ queryKey: [me?.activeCompanyId ?? '', 'settings', 'templates'] });
  const save = useMutation({
    mutationFn: () => api<TemplatesView>('PUT', `${T}/${row.type}`, { showLogo: v.showLogo, showStamp: v.showStamp, showSignature: v.showSignature, ...(v.signatureLabels.join('|') !== row.signatureLabels.join('|') ? { signatureLabels: v.signatureLabels } : {}), version: row.version }), // the labels are sent only when changed: a Save of the toggles never pins the defaults
    onSuccess: () => { setMsg({ ok: true, text: t('saved') }); return refresh(); },
    onError: (e) => { setMsg({ ok: false, text: e instanceof ApiError && e.problem.code === 'record.version_conflict' ? t('conflict') : e instanceof ApiError ? e.problem.title : t('failed') }); void refresh(); },
  });
  const flip = (k: 'showLogo' | 'showStamp' | 'showSignature') => (c: boolean | 'indeterminate') => setV((x) => ({ ...x, [k]: c === true }));
  const pick = (l: string) => setV((x) => ({ ...x, signatureLabels: x.signatureLabels.includes(l) ? x.signatureLabels.filter((y) => y !== l) : x.signatureLabels.length < 4 ? [...x.signatureLabels, l] : x.signatureLabels }));
  return (
    <section aria-labelledby="tpl-editor" className="grid gap-3 rounded-lg border bg-card p-4">
      <h2 id="tpl-editor" className="text-section font-semibold">{name} <span className="text-small font-normal text-muted-foreground">({row.type})</span></h2>
      <div className="grid gap-2">
        {(['showLogo', 'showStamp', 'showSignature'] as const).map((k) => (
          <div key={k} className="flex items-center gap-2"><Checkbox id={`tpl-${k}`} checked={v[k]} onCheckedChange={flip(k)} /><Label htmlFor={`tpl-${k}`}>{t(k)}</Label></div>
        ))}
      </div>
      <fieldset className="grid gap-2" disabled={!v.showSignature}>
        <legend className="text-body font-medium">{t('labels')}</legend>
        <p className="text-small text-muted-foreground">{t('labelsHint', { line: row.issuerLine ?? '' })}</p>
        <div className="flex flex-wrap gap-x-4 gap-y-2">
          {labels.map((l) => (
            <div key={l} className="flex items-center gap-2"><Checkbox id={`tpl-l-${l}`} aria-label={t('labelOf', { label: l })} checked={v.signatureLabels.includes(l)} onCheckedChange={() => pick(l)} /><Label htmlFor={`tpl-l-${l}`}>{l}{v.signatureLabels.includes(l) ? ` (${v.signatureLabels.indexOf(l) + 1})` : ''}</Label></div>
          ))}
        </div>
      </fieldset>
      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={save.isPending || (v.showSignature && v.signatureLabels.length < 1)} onClick={() => { setMsg(undefined); save.mutate(); }}>{t('save')}</Button>
        {v.showSignature && v.signatureLabels.length < 1 ? <span className="text-small text-destructive">{t('tooFew')}</span> : null}
        {msg ? <span role={msg.ok ? 'status' : 'alert'} className={msg.ok ? 'text-small text-muted-foreground' : 'text-small text-destructive'}>{msg.text}</span> : null}
      </div>
    </section>
  );
}

/** ST4: /settings/templates (settings.manage). */
export default function TemplatesPage() {
  return <Inner key={useCompanyEpoch()} />;
}

function Inner() {
  const t = useTranslations('settings.templates');
  const td = useTranslations('docTypes');
  const { me, isError: meFailed, error: meError, refetch: refetchMe } = useMe();
  const id = me?.activeCompanyId ?? '';
  const q = useQuery({ queryKey: [id, 'settings', 'templates'], queryFn: () => api<TemplatesView>('GET', T), enabled: !!id });
  const [sel, setSel] = useState<DocType>('TI');
  const [msg, setMsg] = useState<Msg>();
  if (meFailed && !me) return <ErrorState error={meError} onRetry={() => void refetchMe()} />;
  if (q.isError && !q.data) return isForbidden(q.error) ? <ForbiddenState permission="settings.manage" detail={q.error instanceof ApiError ? q.error.problem.detail : undefined} /> : <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  if (!me || !q.data) return <LoadingState />;
  const row = q.data.items.find((r) => r.type === sel) ?? q.data.items[0];
  return (
    <div className="grid gap-4">
      <div><h1 className="text-title font-semibold">{t('title')}</h1><p className="text-body text-muted-foreground">{t('lead')}</p><p className="mt-1 text-small"><Link className="underline" href="/settings/company">{t('notesLink')}</Link></p></div>
      <div className="grid gap-4 lg:grid-cols-[14rem_1fr]">
        <nav aria-label={t('types')} className="flex flex-wrap gap-2 lg:flex-col">
          {q.data.items.map((r) => (
            <Button key={r.type} variant={r.type === row.type ? 'default' : 'outline'} size="sm" aria-pressed={r.type === row.type} className="justify-start" onClick={() => { setMsg(undefined); setSel(r.type); }}>{td(`${r.type}.title`)}</Button>
          ))}
        </nav>
        <div className="grid min-w-0 gap-4">
          <Editor key={`${row.type}-${row.version}`} row={row} labels={q.data.labels} msg={msg} setMsg={setMsg} />
          <TemplatePreview type={row.type} version={row.version} />
        </div>
      </div>
    </div>
  );
}
