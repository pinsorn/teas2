'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useMe } from '@/app-shell/useMe';
import type { FilingForm } from '@/domain/filings';
import { ApiError } from '@/lib/api/client';
import { endpoints } from '@/lib/api/endpoints';
import { formatDateBE, formatMoney } from '@/lib/format';
import { qk } from '@/lib/query/keys';
import { LoadingState } from '../states/LoadingState';

const selectCls = 'h-(--ctl-h) rounded-lg border border-input bg-card px-3 text-body';

/** TX2c: pay a finalized return from a statement line. The server lists the lines that can pay it (money out, after the month, at least the tax; the exact one first); an optional extra row books a fee or the surcharge on the receipt.
 *  The frontend never sums: a mismatch is the server's own message, shown as it is. Needs bank.reconcile (the button is only offered with it). */
export function TaxPaymentDialog({ form, period, onClose }: { form: FilingForm; period: string; onClose: () => void }) {
  const t = useTranslations('filing.payment');
  const qc = useQueryClient();
  const { me } = useMe();
  const id = useId();
  const company = me?.activeCompanyId ?? '';
  const [lineId, setLineId] = useState('');
  const [account, setAccount] = useState('');
  const [amount, setAmount] = useState('');
  const lines = useQuery({ queryKey: [company, 'filings', form, period, 'payment-lines'], queryFn: () => endpoints.taxPaymentLines(form, period), enabled: !!me });
  const accounts = useQuery({ queryKey: qk.postableAccounts(company), queryFn: () => endpoints.postableAccounts(), enabled: !!me });
  const run = useMutation({
    mutationFn: () => endpoints.payTax(lineId, { form, period, ...(account && amount.trim() ? { extras: [{ accountCode: account, amount: amount.trim() }] } : {}) }),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: [company] }); onClose(); },
  });
  const problem = run.error instanceof ApiError ? run.error.problem : run.error ? { title: t('failed'), detail: undefined } : undefined;

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent aria-describedby={undefined} className="max-h-[90dvh] overflow-y-auto sm:max-w-xl" data-testid="tax-payment-dialog">
        <DialogHeader><DialogTitle>{t('pay')}</DialogTitle></DialogHeader>
        {lines.isError ? <Alert variant="destructive" role="alert"><AlertTitle>{lines.error instanceof ApiError ? lines.error.problem.title : t('failed')}</AlertTitle></Alert> : null}
        {!lines.data && !lines.isError ? <LoadingState /> : null}
        {lines.data ? (
          <>
            <p className="text-body">{t('due', { amount: formatMoney(lines.data.due) })}</p>
            {lines.data.lines.length === 0 ? (
              <p className="text-body" data-testid="no-lines">{t('noLines')} <Link href="/finance/bank-accounts" className="text-primary underline underline-offset-2">{t('importFirst')}</Link></p>
            ) : (
              <fieldset className="grid gap-2">
                <legend className="mb-1 text-body font-medium">{t('pickLine')}</legend>
                {lines.data.lines.map((l) => {
                  const exact = l.amount.replace('-', '') === lines.data.due;
                  return (
                    <label key={l.id} className="flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border bg-card p-2 has-checked:border-primary">
                      <input type="radio" name={`${id}-line`} value={l.id} checked={lineId === l.id} onChange={() => setLineId(l.id)} />
                      <span className="tabular-nums">{formatDateBE(l.date)}</span>
                      <span className="min-w-0 flex-1 truncate">{l.description}</span>
                      <strong className="tabular-nums">−{formatMoney(l.amount.replace('-', ''))}</strong>
                      {exact ? <span className="text-small text-primary">{t('exact')}</span> : null}
                    </label>
                  );
                })}
              </fieldset>
            )}
            <fieldset className="grid gap-2">
              <legend className="mb-1 text-body font-medium">{t('extraTitle')}</legend>
              <p className="text-small text-muted-foreground">{t('extraHint')}</p>
              <div className="flex flex-wrap items-end gap-2">
                <div className="grid gap-1.5">
                  <Label htmlFor={`${id}-acct`}>{t('extraAccount')}</Label>
                  <select id={`${id}-acct`} className={selectCls} value={account} onChange={(e) => setAccount(e.target.value)}>
                    <option value="">{t('extraNone')}</option>
                    {(accounts.data ?? []).map((a) => <option key={a.code} value={a.code}>{a.code} {a.nameTh}</option>)}
                  </select>
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor={`${id}-amt`}>{t('extraAmount')}</Label>
                  <Input id={`${id}-amt`} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className="w-32 text-end" />
                </div>
              </div>
            </fieldset>
          </>
        ) : null}
        {problem ? (
          <Alert variant="destructive" role="alert">
            <AlertTitle>{problem.title}</AlertTitle>
            {problem.detail ? <AlertDescription className="text-foreground!">{problem.detail}</AlertDescription> : null}
          </Alert>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t('back')}</Button>
          <Button disabled={!lineId || run.isPending} onClick={() => run.mutate()}>{run.isPending ? t('working') : t('submit')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
