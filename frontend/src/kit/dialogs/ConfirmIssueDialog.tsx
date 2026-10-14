'use client';
import { useTranslations } from 'next-intl';
import { useRef } from 'react';
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import type { DocTotals } from '@/domain/types';
import { formatMoney, formatTHB } from '@/lib/format';

/** SP1 design system section 6: title = verb + object, consequence line, the totals being committed, back + the verb button. */
export function ConfirmIssueDialog({ open, title, totals, onConfirm, onCancel }: {
  open: boolean; title: string; totals: DocTotals; onConfirm: () => void; onCancel: () => void;
}) {
  const t = useTranslations('docEditor');
  const ts = useTranslations('docEditor.totals');
  const confirmRef = useRef<HTMLButtonElement>(null);
  return (
    <AlertDialog open={open} onOpenChange={(o) => { if (!o) onCancel(); }}>
      <AlertDialogContent onOpenAutoFocus={(e) => { e.preventDefault(); confirmRef.current?.focus(); }}>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{t('confirm.body')}</AlertDialogDescription>
        </AlertDialogHeader>
        <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-body">
          <dt className="text-muted-foreground">{ts('net')}</dt><dd className="text-right tabular-nums">{formatMoney(totals.net)}</dd>
          <dt className="text-muted-foreground">{ts('vat')}</dt><dd className="text-right tabular-nums">{formatMoney(totals.vat)}</dd>
          <dt className="border-t border-foreground pt-1 font-semibold">{ts('totalLabel')}</dt>
          <dd className="border-t border-foreground pt-1 text-right font-semibold tabular-nums">{formatTHB(totals.total)}</dd>
        </dl>
        <p className="text-small text-muted-foreground">({totals.amountInWords})</p>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('confirm.back')}</AlertDialogCancel>
          <Button ref={confirmRef} type="button" onClick={onConfirm}>{title}</Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
