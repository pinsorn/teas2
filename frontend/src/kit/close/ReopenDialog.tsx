'use client';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';
import { Alert, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError } from '@/lib/api/client';

/** Reopening a month or a year needs a reason (audited, kept in the history). The server's refusal shows in place. */
export function ReopenDialog({ title, body, pending, error, onConfirm, onClose }: { title: string; body: string; pending: boolean; error: unknown; onConfirm: (reason: string) => void; onClose: () => void }) {
  const t = useTranslations('periodClose.reopen');
  const tp = useTranslations('problem');
  const id = useId();
  const [reason, setReason] = useState('');
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription>{body}</DialogDescription></DialogHeader>
        <form noValidate className="grid gap-3" onSubmit={(e) => { e.preventDefault(); onConfirm(reason); }}>
          <div className="grid gap-1.5"><Label htmlFor={id}>{t('reason')}</Label><Input id={id} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus /></div>
          {error ? <Alert variant="destructive" role="alert"><AlertTitle>{error instanceof ApiError ? error.problem.title : tp('default')}</AlertTitle></Alert> : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>{t('cancel')}</Button>
            <Button type="submit" disabled={pending || !reason.trim()}>{pending ? t('working') : t('confirm')}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
