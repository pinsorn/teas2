'use client';
import { useTranslations } from 'next-intl';
import { useRef } from 'react';
import { Alert, AlertTitle } from '@/components/ui/alert';
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import type { FilingBox } from '@/domain/filings';
import { ApiError } from '@/lib/api/client';
import { formatMoney, formatTHB } from '@/lib/format';

/** ConfirmIssue anatomy: title = verb + object, the consequence line, the main boxes being committed, back + the verb button. The server's refusal (stale preview, a new blocker) shows in place. */
export function FinalizeDialog({ open, month, boxes, pending, error, onConfirm, onCancel }: { open: boolean; month: string; boxes: FilingBox[]; pending: boolean; error: unknown; onConfirm: () => void; onCancel: () => void }) {
  const t = useTranslations('filing.finalize');
  const tp = useTranslations('problem');
  const confirmRef = useRef<HTMLButtonElement>(null);
  const box = (code: string) => boxes.find((b) => b.code === code);
  const net = box('11');
  return (
    <AlertDialog open={open} onOpenChange={(o) => { if (!o) onCancel(); }}>
      <AlertDialogContent onOpenAutoFocus={(e) => { e.preventDefault(); confirmRef.current?.focus(); }}>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('title', { month })}</AlertDialogTitle>
          <AlertDialogDescription>{t('body')}</AlertDialogDescription>
        </AlertDialogHeader>
        <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-body">
          <dt className="text-muted-foreground">{t('taxOut')}</dt><dd className="text-right tabular-nums">{formatMoney(box('5')?.amount ?? '0.00')}</dd>
          <dt className="text-muted-foreground">{t('taxIn')}</dt><dd className="text-right tabular-nums">{formatMoney(box('7')?.amount ?? '0.00')}</dd>
          <dt className="border-t border-foreground pt-1 font-semibold">{net?.labelTh}</dt>
          <dd className="border-t border-foreground pt-1 text-right font-semibold tabular-nums">{formatTHB(net?.amount ?? '0.00')}</dd>
        </dl>
        {error ? <Alert variant="destructive" role="alert"><AlertTitle>{error instanceof ApiError ? error.problem.title : tp('default')}</AlertTitle></Alert> : null}
        <AlertDialogFooter>
          <AlertDialogCancel>{t('back')}</AlertDialogCancel>
          <Button ref={confirmRef} type="button" disabled={pending} onClick={onConfirm}>{pending ? t('working') : t('button')}</Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
