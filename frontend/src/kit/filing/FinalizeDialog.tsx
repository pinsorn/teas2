'use client';
import { useTranslations } from 'next-intl';
import { useRef, useState } from 'react';
import { Alert, AlertTitle } from '@/components/ui/alert';
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import type { FilingBox, FilingForm } from '@/domain/filings';
import { ApiError } from '@/lib/api/client';
import { formatMoney, formatTHB } from '@/lib/format';

/** ConfirmIssue anatomy: title = verb + object, the consequence line, the main boxes being committed, back + the verb button. The server's refusal (stale preview, a new blocker) shows in place.
 *  The ภ.พ.36 books VAT, so it asks for an acknowledgement first (parity): the button stays off until it is ticked, and the tick is sent with the request. */
export function FinalizeDialog({ open, form, month, boxes, pending, error, onConfirm, onCancel }: { open: boolean; form: FilingForm; month: string; boxes: FilingBox[]; pending: boolean; error: unknown; onConfirm: (ack: boolean) => void; onCancel: () => void }) {
  const t = useTranslations('filing.finalize');
  const tp = useTranslations('problem');
  const tf = useTranslations('filing.forms');
  const [ack, setAck] = useState(false);
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) { setWasOpen(open); if (!open) setAck(false); } // F2: the tick never survives a finalize (the parent closes the dialog) or a close
  const vat = form === 'PP30', cit = form === 'PND50' || form === 'PND51' || form === 'PND1A', payroll = form === 'PND1' || form === 'PND1A' || form === 'SSO1-10', needAck = form === 'PP36'; // PY3: the ภ.ง.ด.1ก names a year; the payroll returns lock payroll runs
  const confirmRef = useRef<HTMLButtonElement>(null);
  const box = (code: string) => boxes.find((b) => b.code === code);
  const net = Number(box('12')?.amount) > 0 ? box('12') : box('11'); // the net payable, or the net overpaid when the month overpays
  return (
    <AlertDialog open={open} onOpenChange={(o) => { if (!o) { setAck(false); onCancel(); } }}>
      <AlertDialogContent onOpenAutoFocus={(e) => { e.preventDefault(); confirmRef.current?.focus(); }}>
        <AlertDialogHeader>
          <AlertDialogTitle>{cit ? t('titleYear', { form: tf(form), year: month }) : t('title', { form: tf(form), month })}</AlertDialogTitle>
          <AlertDialogDescription>{vat ? t('body') : payroll ? t('bodyPayroll') : cit ? t('bodyCit') : t('bodyOther')}</AlertDialogDescription>
        </AlertDialogHeader>
        {vat ? (
          <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-body">
            <dt className="text-muted-foreground">{t('taxOut')}</dt><dd className="text-right tabular-nums">{formatMoney(box('5')?.amount ?? '0.00')}</dd>
            <dt className="text-muted-foreground">{t('taxIn')}</dt><dd className="text-right tabular-nums">{formatMoney(box('7')?.amount ?? '0.00')}</dd>
            <dt className="border-t border-foreground pt-1 font-semibold">{net?.labelTh}</dt>
            <dd className="border-t border-foreground pt-1 text-right font-semibold tabular-nums">{formatTHB(net?.amount ?? '0.00')}</dd>
          </dl>
        ) : (
          <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-body">
            {boxes.map((b) => <div key={b.code} className="contents"><dt className="text-muted-foreground">{b.labelTh}</dt><dd className="text-right tabular-nums">{b.kind === 'count' ? b.amount : formatMoney(b.amount)}</dd></div>)}
          </dl>
        )}
        {needAck ? (
          <div className="flex items-start gap-2">
            <Checkbox id="filing-ack" checked={ack} onCheckedChange={(c) => setAck(c === true)} className="mt-0.5" />
            <Label htmlFor="filing-ack" className="font-normal leading-snug">{t('ack')}</Label>
          </div>
        ) : null}
        {error ? <Alert variant="destructive" role="alert"><AlertTitle>{error instanceof ApiError ? error.problem.title : tp('default')}</AlertTitle></Alert> : null}
        <AlertDialogFooter>
          <AlertDialogCancel>{t('back')}</AlertDialogCancel>
          <Button ref={confirmRef} type="button" disabled={pending || (needAck && !ack)} onClick={() => onConfirm(ack)}>{pending ? t('working') : t('button')}</Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
