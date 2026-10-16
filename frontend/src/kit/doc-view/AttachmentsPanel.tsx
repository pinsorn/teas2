'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useId, useRef, useState } from 'react';
import { useMe } from '@/app-shell/useMe';
import { Alert, AlertTitle } from '@/components/ui/alert';
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { Attachment, AttachmentCategory, DocType } from '@/domain/types';
import { ApiError } from '@/lib/api/client';
import { endpoints } from '@/lib/api/endpoints';
import { formatDateBE } from '@/lib/format';
import { qk } from '@/lib/query/keys';
import { ErrorState } from '../states/ErrorState';
import { LoadingState } from '../states/LoadingState';

const CATEGORIES: AttachmentCategory[] = ['customer_po', 'purchase_order', 'delivery', 'vendor_tax_invoice', 'receipt', 'transfer_slip',
  'contract', 'photo', 'wht_certificate', 'government', 'other'];
const readAsDataUrl = (f: File) => new Promise<string>((ok, no) => { const r = new FileReader(); r.onload = () => ok(String(r.result)); r.onerror = () => no(r.error); r.readAsDataURL(f); });

/** Files attached to a document (D-30 categories). The server owns the limits (1 MB, pdf / png / jpeg / webp); its refusal is shown in place.
 *  `ensureDocId` lets a not-yet-saved editor create its draft first; without a document id and without it, nothing can be attached. */
export function AttachmentsPanel({ type, docId, ensureDocId, canEdit, issued }: {
  type: DocType; docId?: string; ensureDocId?: () => Promise<string | undefined>; canEdit: boolean; /** Removing from an issued document is audited: say so before it happens. */ issued: boolean;
}) {
  const t = useTranslations('docView.attachments');
  const tp = useTranslations('problem');
  const { me } = useMe();
  const qc = useQueryClient();
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [category, setCategory] = useState<AttachmentCategory>('other');
  const [error, setError] = useState<unknown>();
  const [note, setNote] = useState<string>();
  const [confirming, setConfirming] = useState<Attachment>();
  const companyId = me?.activeCompanyId ?? '';
  const q = useQuery({ queryKey: qk.attachments(companyId, type, docId ?? ''), queryFn: () => endpoints.listAttachments(type, docId!), enabled: !!me && !!docId });
  const refresh = (forId: string) => {
    void qc.invalidateQueries({ queryKey: qk.attachments(companyId, type, forId) });
    void qc.invalidateQueries({ queryKey: qk.activity(companyId, type, forId) });
  };

  const add = useMutation({
    mutationFn: async (file: File) => {
      const target = docId ?? (await ensureDocId?.());
      if (!target) throw new Error('needDraft');
      const dataUrl = await readAsDataUrl(file).catch(() => { throw new Error('readFailed'); });
      await endpoints.addAttachment(type, target, { category, name: file.name, mime: file.type, dataUrl });
      return target;
    },
    onMutate: () => { setError(undefined); setNote(undefined); },
    onSuccess: (target) => refresh(target),
    onError: (e) => { if (e instanceof ApiError) setError(e); else setNote(t(e instanceof Error && e.message === 'readFailed' ? 'readFailed' : 'needDraft')); },
    onSettled: () => { if (input.current) input.current.value = ''; },
  });
  const remove = useMutation({
    mutationFn: (a: Attachment) => endpoints.removeAttachment(type, a.docId, a.id),
    onMutate: () => setError(undefined),
    onSuccess: (_r, a) => { setConfirming(undefined); refresh(a.docId); },
    onError: (e) => { setConfirming(undefined); setError(e); },
  });

  return (
    <section aria-labelledby={`${id}-t`} className="grid gap-3 rounded-xl bg-card p-4 ring-1 ring-foreground/10">
      <h2 id={`${id}-t`} className="text-section font-semibold">{t('title')}</h2>
      {canEdit ? (
        <div className="flex flex-wrap items-end gap-2">
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-cat`}>{t('category')}</Label>
            <Select value={category} onValueChange={(v) => setCategory(v as AttachmentCategory)}>
              <SelectTrigger id={`${id}-cat`} className="w-60"><SelectValue /></SelectTrigger>
              <SelectContent>{CATEGORIES.map((c) => <SelectItem key={c} value={c}>{t(`categories.${c}`)}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-file`}>{t('file')}</Label>
            <input ref={input} id={`${id}-file`} type="file" accept="application/pdf,image/png,image/jpeg,image/webp" disabled={add.isPending}
              className="text-body file:mr-2 file:rounded-md file:border file:border-input file:bg-card file:px-3 file:py-1"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) add.mutate(f); }} />
          </div>
          <p className="text-small text-muted-foreground">{t('limits')}</p>
        </div>
      ) : null}
      {note ? <Alert role="status"><AlertTitle>{note}</AlertTitle></Alert> : null}
      {error ? <Alert variant="destructive" role="alert"><AlertTitle>{error instanceof ApiError ? error.problem.title : tp('default')}</AlertTitle></Alert> : null}
      {!docId ? <p className="text-body text-muted-foreground">{t('empty')}</p>
        : q.isPending ? <LoadingState rows={2} />
        : q.error ? <ErrorState error={q.error} onRetry={() => void q.refetch()} />
        : !q.data.length ? <p className="text-body text-muted-foreground">{t('empty')}</p>
        : (
          <ul className="grid gap-2">
            {q.data.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border pb-2 last:border-0">
                <a className="font-medium text-primary hover:underline" href={a.dataUrl} download={a.name} target="_blank" rel="noreferrer">{a.name}</a>
                <span className="rounded-md bg-muted px-2 text-small text-muted-foreground">{t(`categories.${a.category}`)}</span>
                <span className="text-small tabular-nums text-muted-foreground">{t('kb', { size: Math.max(1, Math.round(a.size / 1024)) })}</span>
                <span className="text-small text-muted-foreground">{t('by', { name: a.by })} · <time dateTime={a.at} className="tabular-nums">{formatDateBE(a.at.slice(0, 10))}</time></span>
                {canEdit ? (
                  <Button size="sm" variant="ghost" className="ml-auto" aria-label={t('removeNamed', { name: a.name })} disabled={remove.isPending}
                    onClick={() => (issued ? setConfirming(a) : remove.mutate(a))}>{t('remove')}</Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      {confirming ? (
        <AlertDialog open onOpenChange={(o) => { if (!o) setConfirming(undefined); }}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t('removeTitle')}</AlertDialogTitle>
              <AlertDialogDescription>{t('removeBody', { name: confirming.name })}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t('back')}</AlertDialogCancel>
              <Button type="button" disabled={remove.isPending} onClick={() => remove.mutate(confirming)}>{t('removeConfirm')}</Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
    </section>
  );
}
