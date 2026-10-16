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

/** Records the customer's answer on a quotation. Rejecting needs a reason; accepting is a plain confirmation. The server's refusal is shown in place. */
export function MarkDialog({ mark, docLabel, busy, error, onConfirm, onCancel }: {
  mark: 'accepted' | 'rejected' | 'delivered' | 'sent'; docLabel: string; busy?: boolean; error?: unknown; onConfirm: (reason?: string) => void; onCancel: () => void;
}) {
  const t = useTranslations('docView.mark');
  const tp = useTranslations('problem');
  const id = useId();
  const [reason, setReason] = useState('');
  const ok = !busy && (mark !== 'rejected' || !!reason.trim());
  return (
    <AlertDialog open onOpenChange={(o) => { if (!o) onCancel(); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t(`${mark}Title`, { doc: docLabel })}</AlertDialogTitle>
          <AlertDialogDescription>{t(`${mark}Body`)}</AlertDialogDescription>
        </AlertDialogHeader>
        {mark === 'rejected' ? (
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-reason`}>{t('reason')}</Label>
            <Textarea id={`${id}-reason`} value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
        ) : null}
        {error ? <Alert variant="destructive"><AlertTitle>{error instanceof ApiError ? error.problem.title : tp('default')}</AlertTitle></Alert> : null}
        <AlertDialogFooter>
          <AlertDialogCancel>{t('back')}</AlertDialogCancel>
          <Button type="button" disabled={!ok} onClick={() => onConfirm(mark === 'rejected' ? reason.trim() : undefined)}>{t('confirm')}</Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
