'use client';
import { useTranslations } from 'next-intl';
import { useRef } from 'react';
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Alert, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import type { CorrectionPlan } from '@/domain/types';
import { ApiError } from '@/lib/api/client';

/** SP0 section 7.3: one "แก้ไข" button, the system picks the behaviour. This shows what it will do, in order, before anything is written. */
export function CorrectionPlanDialog({ plan, busy, error, onConfirm, onSendToApprover, onCancel }: {
  plan: CorrectionPlan; busy?: boolean; error?: unknown; onConfirm: () => void; onSendToApprover: () => void; onCancel: () => void;
}) {
  const t = useTranslations('docView.plan');
  const tp = useTranslations('problem');
  const confirmRef = useRef<HTMLButtonElement>(null);
  const blocked = plan.missingPermissions.length > 0;
  return (
    <AlertDialog open onOpenChange={(o) => { if (!o) onCancel(); }}>
      <AlertDialogContent className="sm:max-w-xl" onOpenAutoFocus={(e) => { e.preventDefault(); confirmRef.current?.focus(); }}>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('title')}</AlertDialogTitle>
          <AlertDialogDescription>{plan.explanation}</AlertDialogDescription>
        </AlertDialogHeader>
        {plan.steps.length ? (
          <div className="grid gap-1.5">
            <p className="text-small text-muted-foreground">{t('steps')}</p>
            <ol className="grid list-decimal gap-2 pl-5">
              {plan.steps.map((s) => (
                <li key={s.order} className="text-body">
                  <span className="font-medium">{t(`action.${s.action}`)}</span>{' '}
                  <span className="tabular-nums text-muted-foreground">{s.docType}{s.number ? ` ${s.number}` : ''}</span>
                  <div className="text-small text-muted-foreground">{s.summary}</div>
                </li>
              ))}
            </ol>
          </div>
        ) : <p className="text-body">{t('noSteps')}</p>}
        {blocked ? <p className="text-body text-destructive">{t('missing', { list: plan.missingPermissions.join(', ') })}</p> : null}
        {error ? <Alert variant="destructive"><AlertTitle>{error instanceof ApiError ? error.problem.title : tp('default')}</AlertTitle></Alert> : null}
        <AlertDialogFooter>
          <AlertDialogCancel>{t('back')}</AlertDialogCancel>
          {blocked ? <Button type="button" variant="outline" onClick={onSendToApprover}>{t('send')}</Button> : null}
          <Button ref={confirmRef} type="button" disabled={blocked || busy || !plan.steps.length} onClick={onConfirm}>{t('confirm')}</Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
