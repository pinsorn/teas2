'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';
import { useMe } from '@/app-shell/useMe';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import type { Doc } from '@/domain/types';
import { api } from '@/lib/api/client';
import { endpoints } from '@/lib/api/endpoints';
import { formatDateBE, formatMoney, todayIso } from '@/lib/format';
import { Guarded } from '../doc-view/Guarded';
import { selectCls } from '../opening/fields';
import { FormRow, Problem, fieldError } from '../schedules/ScheduleDialogs';

export const PAY_PERMISSION = 'doc.PR.pay';
const run = (doc: Doc) => doc.number ?? doc.id;

/** "จ่ายเงินเดือน": the whole run, from one own bank / cash account, on a date. The amount shown is the run's stored net (the server pays exactly that). The server's refusal (date, period, account, stale version) shows in place. */
export function PayRunDialog({ doc, onClose }: { doc: Doc; onClose: () => void }) {
  const t = useTranslations('payrollPay.pay');
  const id = useId();
  const qc = useQueryClient();
  const { me } = useMe();
  const company = me?.activeCompanyId ?? '';
  const accounts = useQuery({ queryKey: [company, 'records', 'bank-account', 'payroll-pay'], queryFn: () => endpoints.listRecords('bank-account', { active: 'true', limit: 100 }), enabled: !!me });
  const items = accounts.data?.items ?? [];
  const [picked, setPicked] = useState<string>();
  const accountId = picked ?? (items.length === 1 ? items[0].id : String(items.find((a) => a.default === true)?.id ?? ''));
  const min = doc.header.documentDate;
  const [date, setDate] = useState(() => { const d = me?.businessDate ?? todayIso(); return d < min ? min : d; });
  const go = useMutation({
    mutationFn: () => api<Doc>('POST', `/docs/PR/${encodeURIComponent(doc.id)}/pay`, { accountId, date, version: doc.version }),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: [company] }); onClose(); },
  });
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent aria-describedby={undefined} className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader><DialogTitle>{t('title', { run: run(doc) })}</DialogTitle><DialogDescription>{t('body')}</DialogDescription></DialogHeader>
        <form noValidate className="grid gap-3" onSubmit={(e) => { e.preventDefault(); go.mutate(); }}>
          <div className="flex items-baseline justify-between gap-3 rounded-lg bg-muted/40 p-3">
            <span className="text-muted-foreground">{t('amount')}</span>
            <strong className="tabular-nums text-h3" data-testid="pay-amount">{formatMoney(doc.totals.net)}</strong>
          </div>
          <FormRow label={t('account')} htmlFor={`${id}-account`} error={fieldError(go.error, 'accountId')}>
            <select id={`${id}-account`} className={selectCls} value={accountId} disabled={accounts.isPending} onChange={(e) => setPicked(e.target.value)}>
              <option value="">{accounts.isPending ? t('loading') : items.length ? t('choose') : t('noAccounts')}</option>
              {items.map((a) => <option key={a.id} value={a.id}>{String(a.accountCode)} {String(a.accountName ?? a.nameTh ?? a.id)}</option>)}
            </select>
          </FormRow>
          <FormRow label={t('date')} htmlFor={`${id}-date`} error={fieldError(go.error, 'date')}>
            <Input id={`${id}-date`} type="date" min={min} value={date} onChange={(e) => setDate(e.target.value)} />
          </FormRow>
          <p className="text-small text-muted-foreground">{t('dateHint', { date: formatDateBE(min) })}</p>
          <Problem error={go.error} />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>{t('cancel')}</Button>
            <Button type="submit" disabled={go.isPending || !accountId || !date}>{go.isPending ? t('submitting') : t('submit')}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** "ยกเลิกการจ่าย": a reason is required (audited). Refused by the server while the payment is matched to a bank line; the exit shows in place. */
export function UnpayDialog({ doc, onClose }: { doc: Doc; onClose: () => void }) {
  const t = useTranslations('payrollPay.unpay');
  const id = useId();
  const qc = useQueryClient();
  const { me } = useMe();
  const [reason, setReason] = useState('');
  const go = useMutation({
    mutationFn: () => api<Doc>('POST', `/docs/PR/${encodeURIComponent(doc.id)}/unpay`, { reason, version: doc.version }),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: [me?.activeCompanyId] }); onClose(); },
  });
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent aria-describedby={undefined} className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader><DialogTitle>{t('title', { run: run(doc) })}</DialogTitle><DialogDescription>{t('body')}</DialogDescription></DialogHeader>
        <form noValidate className="grid gap-3" onSubmit={(e) => { e.preventDefault(); go.mutate(); }}>
          <FormRow label={t('reason')} htmlFor={`${id}-reason`} error={fieldError(go.error, 'reason')}><Textarea id={`${id}-reason`} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus /></FormRow>
          <Problem error={go.error} />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>{t('cancel')}</Button>
            <Button type="submit" disabled={go.isPending || !reason.trim()}>{go.isPending ? t('submitting') : t('submit')}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** The two payroll buttons of the action bar: pay an issued run, unpay a paid one. A disabled button says why (permission). */
export function PayrollActions({ doc, permissions, needPermission }: { doc: Doc; permissions: string[]; needPermission: (permission: string) => string }) {
  const t = useTranslations('payrollPay');
  const [open, setOpen] = useState<'pay' | 'unpay'>();
  const why = permissions.includes(PAY_PERMISSION) ? undefined : needPermission(PAY_PERMISSION);
  if (doc.status !== 'issued' && doc.status !== 'settled') return null;
  const paid = doc.status === 'settled';
  return (
    <>
      <Guarded why={why}>{(p) => <Button {...p} variant={paid ? 'outline' : 'default'} onClick={() => setOpen(paid ? 'unpay' : 'pay')}>{t(paid ? 'unpayAction' : 'action')}</Button>}</Guarded>
      {open === 'pay' ? <PayRunDialog doc={doc} onClose={() => setOpen(undefined)} /> : null}
      {open === 'unpay' ? <UnpayDialog doc={doc} onClose={() => setOpen(undefined)} /> : null}
    </>
  );
}
