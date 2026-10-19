'use client';
import { CheckCircle2Icon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useId, useState, type ReactNode } from 'react';
import { Alert, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { ApiError } from '@/lib/api/client';

/** One block of a settings page with its own Save (each save is one audited command). A failure is shown in the block; `onError` lets the page put field errors under their fields. */
export function SettingsSection({ title, description, onSave, onError, disabled, hideSave, children }: {
  title: string; description?: string; onSave: () => Promise<unknown>; onError?: (e: ApiError) => void; disabled?: boolean; hideSave?: boolean; children: ReactNode;
}) {
  const t = useTranslations('settings.common');
  const id = useId();
  const [state, setState] = useState<{ kind: 'idle' | 'saving' | 'saved' | 'error'; message?: string }>({ kind: 'idle' });
  const submit = async () => {
    setState({ kind: 'saving' });
    try { await onSave(); setState({ kind: 'saved' }); } catch (e) {
      if (e instanceof ApiError) onError?.(e);
      setState({ kind: 'error', message: e instanceof ApiError ? e.problem.title : t('failed') });
    }
  };
  return (
    <section aria-labelledby={id} className="grid gap-3 rounded-lg border bg-card p-4">
      <div>
        <h2 id={id} className="text-section font-semibold">{title}</h2>
        {description ? <p className="text-body text-muted-foreground">{description}</p> : null}
      </div>
      <form noValidate onSubmit={(e) => { e.preventDefault(); void submit(); }} className="grid gap-3">
        {children}
        {state.kind === 'error' ? <Alert variant="destructive" role="alert"><AlertTitle>{state.message}</AlertTitle></Alert> : null}
        {hideSave && state.kind !== 'saved' ? null : (
          <div className="flex flex-wrap items-center justify-end gap-3">
            {state.kind === 'saved' ? <span role="status" className="inline-flex items-center gap-1 text-small text-muted-foreground"><CheckCircle2Icon aria-hidden className="size-4" />{t('saved')}</span> : null}
            {hideSave ? null : <Button type="submit" disabled={disabled || state.kind === 'saving'}>{state.kind === 'saving' ? t('saving') : t('save')}</Button>}
          </div>
        )}
      </form>
    </section>
  );
}
