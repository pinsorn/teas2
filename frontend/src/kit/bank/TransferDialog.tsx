'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { useMe } from '@/app-shell/useMe';
import type { BankLine } from '@/domain/types';
import { ApiError } from '@/lib/api/client';
import { endpoints } from '@/lib/api/endpoints';
import { formatDateBE, formatMoney } from '@/lib/format';

const selectCls = 'h-(--ctl-h) rounded-lg border border-input bg-card px-3 text-body';

/** I2: the line is money moving between two of the company's own accounts. One journal (Dr receiving / Cr paying), this line matched to it; the other account's line is offered the same journal. */
export function TransferDialog({ line, accountId, onClose }: { line: BankLine; accountId: string; onClose: () => void }) {
  const t = useTranslations('bank.reconcile');
  const qc = useQueryClient();
  const { me } = useMe();
  const id = useId();
  const company = me?.activeCompanyId ?? '';
  const [to, setTo] = useState('');
  const accounts = useQuery({ queryKey: [company, 'records', 'bank-account', 'transfer'], queryFn: () => endpoints.listRecords('bank-account', { active: 'true', limit: 100 }), enabled: !!me });
  const options = (accounts.data?.items ?? []).filter((a) => a.id !== accountId);
  const run = useMutation({
    mutationFn: () => endpoints.transferBankLine(line.id, to),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: [company] }); onClose(); },
  });
  const incoming = !line.amount.startsWith('-');

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent aria-describedby={undefined} className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader><DialogTitle>{t('transfer.title')}</DialogTitle></DialogHeader>
        <p className="tabular-nums text-body">{formatDateBE(line.date)} · {line.description} · <strong>{incoming ? '+' : '−'}{formatMoney(line.amount.replace('-', ''))}</strong></p>
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-to`}>{t('transfer.account')}</Label>
          <select id={`${id}-to`} className={selectCls} value={to} onChange={(e) => setTo(e.target.value)}>
            <option value="">{t('transfer.choose')}</option>
            {options.map((a) => <option key={a.id} value={a.id}>{String(a.accountCode)} {String(a.accountName ?? a.nameTh ?? a.id)}</option>)}
          </select>
          <p className="text-small text-muted-foreground">{t('transfer.hint')}</p>
        </div>
        {run.error ? (
          <Alert variant="destructive" role="alert">
            <AlertTitle>{run.error instanceof ApiError ? run.error.problem.title : t('failed')}</AlertTitle>
            {run.error instanceof ApiError && run.error.problem.detail ? <AlertDescription className="text-foreground!">{run.error.problem.detail}</AlertDescription> : null}
          </Alert>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t('cancel')}</Button>
          <Button disabled={!to || run.isPending} onClick={() => run.mutate()}>{run.isPending ? t('transfer.submitting') : t('transfer.submit')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
