'use client';
import { useTranslations } from 'next-intl';
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Alert, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import type { CorrectionPlan } from '@/domain/types';
import { ApiError } from '@/lib/api/client';
import { formatMoney, formatTHB } from '@/lib/format';

/** SP0 section 7.3: one "แก้ไข" button, the system picks the behaviour. This shows what it will do, in order, before anything is written. */
export function CorrectionPlanDialog({ plan, busy, loading, error, onRegenerate, onConfirm, onSendToApprover, onCancel }: {
  plan: CorrectionPlan; busy?: boolean; /** A newer plan is being fetched: this one must not be confirmed meanwhile. */ loading?: boolean; error?: unknown; onRegenerate?: () => void; onConfirm: () => void; onSendToApprover: () => void; onCancel: () => void;
}) {
  const t = useTranslations('docView.plan');
  const tp = useTranslations('problem');
  const blocked = plan.missingPermissions.length > 0;
  return (
    <AlertDialog open onOpenChange={(o) => { if (!o) onCancel(); }}>
      <AlertDialogContent className="sm:max-w-xl">
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
                  {s.note ? <div className="text-small">
                    <p>{s.note.type} · {t(s.note.fullCredit ? 'fullCredit' : 'difference')}</p>
                    <table className="w-full tabular-nums">
                      <thead><tr>{(['taxCode', 'net', 'vat', 'total'] as const).map((key) => <th key={key} scope="col" className="text-left">{t(key)}</th>)}</tr></thead>
                      <tbody>{s.note.taxLines.map((line) => <tr key={line.taxCode}>
                        <th scope="row" className="text-left">{line.taxCode}</th><td>{formatMoney(line.net)}</td><td>{formatMoney(line.vat)}</td><td>{formatMoney(line.total)}</td>
                      </tr>)}</tbody>
                    </table>
                    <p>{t('total')}: {formatTHB(s.note.total)}</p>
                  </div> : null}
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
          {onRegenerate ? <Button type="button" variant="outline" onClick={onRegenerate}>{t('regenerate')}</Button> : null}
          <Button type="button" disabled={blocked || !!onRegenerate || busy || loading || !plan.steps.length} onClick={onConfirm}>{t('confirm')}</Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
