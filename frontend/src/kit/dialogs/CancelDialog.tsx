'use client';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { ApiError } from '@/lib/api/client';

export const CANCEL_REASONS = ['WRONG_PARTY', 'WRONG_AMOUNT', 'WRONG_ITEMS', 'DUPLICATE', 'OTHER'] as const;

/** Cancel is irreversible: a reason code is required (and a text when the code is OTHER). The server's refusal (e.g. an applied receipt) is shown in place. */
export function CancelDialog({ docLabel, busy, error, hint, onConfirm, onCancel }: {
  docLabel: string; busy?: boolean; error?: unknown; hint?: string; onConfirm: (reasonCode: string, reasonText: string) => void; onCancel: () => void;
}) {
  const t = useTranslations('docView.cancel');
  const tp = useTranslations('problem');
  const id = useId();
  const [code, setCode] = useState('');
  const [text, setText] = useState('');
  const ok = !!code && (code !== 'OTHER' || !!text.trim()) && !busy;
  return (
    <AlertDialog open onOpenChange={(o) => { if (!o) onCancel(); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('title', { doc: docLabel })}</AlertDialogTitle>
          <AlertDialogDescription>{t('body')}</AlertDialogDescription>
        </AlertDialogHeader>
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-code`}>{t('reason')}</Label>
          <Select value={code} onValueChange={setCode}>
            <SelectTrigger id={`${id}-code`} className="w-full"><SelectValue placeholder={t('pick')} /></SelectTrigger>
            <SelectContent>{CANCEL_REASONS.map((c) => <SelectItem key={c} value={c}>{t(`code.${c}`)}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-text`}>{t('text')}</Label>
          <Textarea id={`${id}-text`} value={text} onChange={(e) => setText(e.target.value)} />
        </div>
        {error ? <Alert variant="destructive"><AlertTitle>{error instanceof ApiError ? error.problem.title : tp('default')}</AlertTitle>{hint ? <AlertDescription className="text-foreground!">{hint}</AlertDescription> : null}</Alert> : null}
        <AlertDialogFooter>
          <AlertDialogCancel>{t('back')}</AlertDialogCancel>
          <Button type="button" variant="destructive" disabled={!ok} onClick={() => onConfirm(code, text.trim())}>{t('confirm')}</Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
