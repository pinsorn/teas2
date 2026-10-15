'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useMemo, useRef, useState } from 'react';
import { useForm, useWatch, type FieldValues } from 'react-hook-form';
import { z } from 'zod';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useCompanyEpoch } from '@/app-shell/useCompanyEpoch';
import { useMe } from '@/app-shell/useMe';
import type { RecordDescriptor, RecordRow } from '@/domain/records';
import { ApiError } from '@/lib/api/client';
import { endpoints } from '@/lib/api/endpoints';
import { Field, defaultsOf, isVisible, payloadOf, validateShape } from './fields';

export interface RecordFormProps {
  descriptor: RecordDescriptor;
  /** Present = edit this record; absent = create. */
  row?: RecordRow;
  /** Create only: starting values for the form (e.g. the name typed in a document editor). */
  prefill?: Record<string, unknown>;
  onSaved: (row: RecordRow) => void;
  onCancel: () => void;
}

/** Keyed by the active company: a switch throws the typed values away, so company A's data is never saved into B. */
export function RecordForm(props: RecordFormProps) {
  return <RecordFormInner key={useCompanyEpoch()} {...props} />;
}

function RecordFormInner({ descriptor: desc, row: given, prefill, onSaved, onCancel }: RecordFormProps) {
  const tc = useTranslations('records.common');
  const qc = useQueryClient();
  const { me } = useMe();
  // a field limited to one VAT scope is not offered in the other kind of company (the server ignores it there)
  const d = useMemo(() => ({ ...desc, fields: desc.fields.filter((f) => !f.vat || f.vat === 'both' || (f.vat === 'vat-only') === (me?.vatRegistered !== false)) }), [desc, me?.vatRegistered]);
  const idempotencyKey = useRef(crypto.randomUUID());
  const [conflict, setConflict] = useState(false);
  // After a conflict the reload fetches the record itself: the caller's row may be a stale list snapshot, the version must come from the server.
  const [fresh, setFresh] = useState<RecordRow>();
  const row = fresh ?? given;
  const [formError, setFormError] = useState<string>();

  const msg = useMemo(() => ({ required: tc('required'), tin: tc('tinInvalid'), branch: tc('branchInvalid'), int: tc('intInvalid') }), [tc]);
  const schema = useMemo(() => z.record(z.string(), z.unknown()).superRefine((v, ctx) => {
    for (const [key, message] of Object.entries(validateShape(d.fields, v, msg))) ctx.addIssue({ code: 'custom', path: [key], message });
  }), [d.fields, msg]);
  const form = useForm<FieldValues>({ resolver: zodResolver(schema), defaultValues: defaultsOf(d.fields, row ?? prefill) });
  const { handleSubmit, setError, setFocus, control, formState: { errors } } = form;
  const values = useWatch({ control }) as Record<string, unknown>;

  const save = useMutation({
    mutationFn: (v: Record<string, unknown>) => (row
      ? endpoints.updateRecord(d.kind, row.id, v, row.version)
      : endpoints.createRecord(d.kind, v, idempotencyKey.current)),
    onSuccess: async (saved) => {
      await qc.invalidateQueries({ queryKey: [me?.activeCompanyId, 'records', d.kind] });
      await qc.invalidateQueries({ queryKey: [me?.activeCompanyId, 'record', d.kind] });
      onSaved(saved);
    },
    onError: (e) => {
      setConflict(false); setFormError(undefined);
      if (!(e instanceof ApiError)) { setFormError(tc('formError')); return; }
      if (e.code === 'record.version_conflict') { setConflict(true); return; }
      const fe = e.problem.fieldErrors;
      if (e.problem.status === 422 && fe) {
        const shown = d.fields.filter((f) => isVisible(f, values) && fe[f.key]?.length);
        shown.forEach((f, i) => setError(f.key, { type: 'server', message: fe[f.key][0] }, { shouldFocus: i === 0 }));
        if (shown[0]) setFocus(shown[0].key);
        const rest = Object.entries(fe).filter(([k]) => !shown.some((f) => f.key === k)).flatMap(([, m]) => m);
        if (rest.length) setFormError(rest.join(' '));
        else if (!shown.length) setFormError(e.problem.title);
        return;
      }
      setFormError(e.problem.title);
    },
  });

  const reload = async () => {
    if (!given) return;
    try { setFresh(await endpoints.getRecord(d.kind, given.id)); setConflict(false); } catch (e) { setConflict(false); setFormError(e instanceof ApiError ? e.problem.title : tc('formError')); }
    void qc.invalidateQueries({ queryKey: [me?.activeCompanyId] });
  };
  const submit = handleSubmit((v) => { setConflict(false); setFormError(undefined); save.mutate(payloadOf(d.fields, v)); });

  return (
    <form onSubmit={(e) => void submit(e)} noValidate className="grid gap-4">
      {conflict ? (
        <Alert variant="destructive" role="alert">
          <AlertTitle>{tc('conflictTitle')}</AlertTitle>
          <AlertDescription className="text-foreground!">{tc('conflictBody')}</AlertDescription>
          <AlertAction><Button type="button" size="sm" variant="outline" onClick={() => void reload()}>{tc('reload')}</Button></AlertAction>
        </Alert>
      ) : null}
      {formError ? <Alert variant="destructive" role="alert"><AlertTitle>{formError}</AlertTitle></Alert> : null}
      <div className="grid gap-3 sm:grid-cols-2">
        {d.fields.filter((f) => isVisible(f, values)).map((f) => (
          <div key={f.key} className={f.kind === 'textarea' || f.kind === 'item' ? 'sm:col-span-2' : undefined}>
            <Field spec={f} form={form} values={values} error={errors[f.key]?.message as string | undefined} locked={!!f.readOnlyAfterUse && !!row?.inUse} />
          </div>
        ))}
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel}>{tc('cancel')}</Button>
        <Button type="submit" disabled={save.isPending}>{save.isPending ? tc('saving') : tc('save')}</Button>
      </div>
    </form>
  );
}

/** The form in a modal named "เพิ่ม<title>" / "แก้ไข<title>"; closing (Esc, ×, Cancel) drops the typed values. */
export function RecordFormDialog({ descriptor: d, row, prefill, onSaved, onClose }: Omit<RecordFormProps, 'onCancel'> & { onClose: () => void }) {
  const t = useTranslations();
  const title = t(d.titleKey);
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent aria-describedby={undefined} className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader><DialogTitle>{t(row ? 'records.common.editTitle' : 'records.common.create', { title })}</DialogTitle></DialogHeader>
        <RecordForm descriptor={d} row={row} prefill={prefill} onSaved={onSaved} onCancel={onClose} />
      </DialogContent>
    </Dialog>
  );
}
