'use client';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';
import { Alert, AlertTitle } from '@/components/ui/alert';
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ApiError } from '@/lib/api/client';

/** Closing the remainder stops further conversion of what is left; a reason is required, a revision of the document reopens it. The server's refusal is shown in place. */
export function CloseRemainderDialog({ docLabel, busy, error, onConfirm, onCancel }: {
  docLabel: string; busy?: boolean; error?: unknown; onConfirm: (reason: string) => void; onCancel: () => void;
}) {
  const t = useTranslations('docView.closeRemainder');
  const tp = useTranslations('problem');
  const id = useId();
  const [reason, setReason] = useState('');
  return (
    <AlertDialog open onOpenChange={(o) => { if (!o) onCancel(); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('title')}</AlertDialogTitle>
          <AlertDialogDescription>{t('body', { doc: docLabel })}</AlertDialogDescription>
        </AlertDialogHeader>
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-reason`}>{t('reason')}</Label>
          <Textarea id={`${id}-reason`} value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
        {error ? <Alert variant="destructive"><AlertTitle>{error instanceof ApiError ? error.problem.title : tp('default')}</AlertTitle></Alert> : null}
        <AlertDialogFooter>
          <AlertDialogCancel>{t('back')}</AlertDialogCancel>
          <Button type="button" disabled={busy || !reason.trim()} onClick={() => onConfirm(reason.trim())}>{t('confirm')}</Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
