'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RotateCcwIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';
import { useMe, isForbidden } from '@/app-shell/useMe';
import { Alert, AlertTitle } from '@/components/ui/alert';
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { LIVE } from '@/domain/doc-types';
import type { DocType } from '@/domain/types';
import { ApiError } from '@/lib/api/client';
import { endpoints } from '@/lib/api/endpoints';
import { formatDateBE, formatMoney } from '@/lib/format';
import { qk } from '@/lib/query/keys';
import { ErrorState } from '../states/ErrorState';
import { ForbiddenState } from '../states/ForbiddenState';
import { LoadingState } from '../states/LoadingState';

/** "กลับรายการ" (AC1, JV only): the server dates the reversing JV (the first open date or the original's, whichever is later); a later open date may be chosen, never a future one. */
function ReverseDialog({ docLabel, busy, error, onConfirm, onCancel }: { docLabel: string; busy?: boolean; error?: unknown; onConfirm: (date: string, reason: string) => void; onCancel: () => void }) {
  const t = useTranslations('docView.ledger.reverse');
  const tp = useTranslations('problem');
  const id = useId();
  const [date, setDate] = useState('');
  const [reason, setReason] = useState('');
  return (
    <AlertDialog open onOpenChange={(o) => { if (!o) onCancel(); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('title', { doc: docLabel })}</AlertDialogTitle>
          <AlertDialogDescription>{t('body')}</AlertDialogDescription>
        </AlertDialogHeader>
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-date`}>{t('date')}</Label>
          <Input id={`${id}-date`} type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          <p className="text-small text-muted-foreground">{date ? formatDateBE(date) : t('dateHint')}</p>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-reason`}>{t('reason')}</Label>
          <Textarea id={`${id}-reason`} value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
        {error ? <Alert variant="destructive"><AlertTitle>{error instanceof ApiError ? error.problem.title : tp('default')}</AlertTitle></Alert> : null}
        <AlertDialogFooter>
          <AlertDialogCancel>{t('back')}</AlertDialogCancel>
          <Button type="button" disabled={busy} onClick={() => onConfirm(date, reason.trim())}>{t('confirm')}</Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** The journal entries the document produced (originals, reversals, corrections), exactly as the server posted them. A journal voucher's entry carries "กลับรายการ"; a document's entry never does (its own cancel / correction owns it). */
export function LedgerTab({ type, id }: { type: DocType; id: string }) {
  const t = useTranslations('docView.ledger');
  const { me } = useMe();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: qk.ledger(me!.activeCompanyId, type, id), queryFn: () => endpoints.getLedger(type, id) });
  const doc = useQuery({ queryKey: qk.doc(me!.activeCompanyId, type, id), queryFn: () => endpoints.getDoc(type, id), enabled: type === 'JV' }); // the same query as the view: no extra request
  const [open, setOpen] = useState(false);
  const reverse = useMutation({
    mutationFn: (v: { date: string; reason: string }) => endpoints.reverseDoc(type, id, { ...(v.date ? { date: v.date } : {}), ...(v.reason ? { reason: v.reason } : {}) }),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: [me!.activeCompanyId] }); setOpen(false); },
  });
  if (q.isPending) return <LoadingState rows={3} />;
  if (q.error) return isForbidden(q.error) ? <ForbiddenState permission="ledger.read" /> : <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  if (!q.data.entries.length) return <p className="text-body text-muted-foreground">{t('empty')}</p>;
  const d = doc.data;
  const canReverse = type === 'JV' && !!d && LIVE.includes(d.status) && !d.locks.some((l) => l.kind === 'reversal' && !l.exits.length) && !d.header.autoReverse && !!me?.permissions.includes('doc.JV.issue');
  const live = [...q.data.entries].reverse().find((e) => e.kind !== 'reversal');
  return (
    <div className="grid gap-4">
      {type === 'JV' && d?.header.autoReverse && LIVE.includes(d.status) ? <p className="text-small text-muted-foreground" data-testid="jv-auto-note">{t('autoReverseNote')}</p> : null}
      {q.data.entries.map((e, i) => (
        <section key={`${e.number ?? i}-${e.kind}`} className="grid gap-1">
          <h3 className="flex flex-wrap items-center gap-2 text-body font-medium">
            <span>{t(`kind.${e.kind}`)}{e.number ? ` ${e.number}` : ''} <span className="font-normal text-muted-foreground">{formatDateBE(e.date)}</span></span>
            {e.late ? <span className="rounded-sm border px-1.5 py-0.5 text-small font-normal">{t('late')}</span> : null}
            {canReverse && e === live ? (
              <Button type="button" size="sm" variant="outline" onClick={() => { reverse.reset(); setOpen(true); }}><RotateCcwIcon aria-hidden data-icon="inline-start" />{t('reverse.action')}</Button>
            ) : null}
          </h3>
          <table className="w-full text-body">
            <thead>
              <tr className="border-b text-left text-small text-muted-foreground">
                <th scope="col" className="py-1 font-medium">{t('account')}</th>
                <th scope="col" className="py-1 text-right font-medium">{t('debit')}</th>
                <th scope="col" className="py-1 text-right font-medium">{t('credit')}</th>
              </tr>
            </thead>
            <tbody>
              {e.lines.map((l, j) => (
                <tr key={j} className="border-b border-border/50">
                  <td className="py-1"><span className="tabular-nums">{l.accountCode}</span> {l.accountName}{l.partyName ? <span className="text-muted-foreground"> · {l.partyName}</span> : null}</td>
                  <td className="py-1 text-right tabular-nums">{l.debit !== '0.00' ? formatMoney(l.debit) : ''}</td>
                  <td className="py-1 text-right tabular-nums">{l.credit !== '0.00' ? formatMoney(l.credit) : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
      {open && d ? <ReverseDialog docLabel={`${d.type} ${d.number ?? ''}`.trim()} busy={reverse.isPending} error={reverse.error} onCancel={() => setOpen(false)} onConfirm={(date, reason) => reverse.mutate({ date, reason })} /> : null}
    </div>
  );
}
