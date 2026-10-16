'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useMe } from '@/app-shell/useMe';
import type { BankLine } from '@/domain/types';
import { ApiError } from '@/lib/api/client';
import { endpoints } from '@/lib/api/endpoints';
import { formatDateBE, formatMoney } from '@/lib/format';
import { qk } from '@/lib/query/keys';

const selectCls = 'h-(--ctl-h) rounded-lg border border-input bg-card px-3 text-body';

/** FN2: book a statement line nothing matches (a fee, interest, a transfer) straight to an account: two lines, the bank's GL account against the chosen one, dated at the line. The tax control
 *  accounts are not offered (the server refuses them too); a receivable / payable asks for its party. Once posted the line is final - the way back is reversing the journal. */
export function InlineJournalDialog({ line, bankAccountCode, onClose }: { line: BankLine; bankAccountCode: string; onClose: () => void }) {
  const t = useTranslations('bank.reconcile');
  const qc = useQueryClient();
  const { me } = useMe();
  const id = useId();
  const company = me?.activeCompanyId ?? '';
  const [code, setCode] = useState('');
  const [description, setDescription] = useState(line.description);
  const [partyQ, setPartyQ] = useState('');
  const [partyId, setPartyId] = useState('');
  const accounts = useQuery({ queryKey: qk.postableAccounts(company), queryFn: () => endpoints.postableAccounts(), enabled: !!me });
  const options = (accounts.data ?? []).filter((a) => a.code !== bankAccountCode);
  const chosen = options.find((a) => a.code === code);
  const parties = useQuery({
    queryKey: [company, 'parties', chosen?.party, partyQ], enabled: !!chosen?.party,
    queryFn: () => endpoints.searchParties({ kind: chosen!.party, q: partyQ || undefined, limit: 20 }),
  });
  const run = useMutation({
    mutationFn: () => endpoints.postBankLine(line.id, { accountCode: code, description: description.trim() || undefined, ...(chosen?.party && partyId ? { partyId } : {}) }),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: [company] }); onClose(); },
  });
  const incoming = !line.amount.startsWith('-');

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent aria-describedby={undefined} className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader><DialogTitle>{t('post.title')}</DialogTitle></DialogHeader>
        <p className="tabular-nums text-body">{formatDateBE(line.date)} · {line.description} · <strong>{incoming ? '+' : '−'}{formatMoney(line.amount.replace('-', ''))}</strong></p>
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-acct`}>{incoming ? t('post.creditAccount') : t('post.debitAccount')}</Label>
          <select id={`${id}-acct`} className={selectCls} value={code} onChange={(e) => { setCode(e.target.value); setPartyId(''); }}>
            <option value="">{t('post.choose')}</option>
            {options.map((a) => <option key={a.code} value={a.code}>{a.code} {a.nameTh}</option>)}
          </select>
          <p className="text-small text-muted-foreground">{t('post.controlHint')}</p>
        </div>
        {chosen?.party ? (
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-pq`}>{t('post.party')}</Label>
            <Input id={`${id}-pq`} value={partyQ} onChange={(e) => setPartyQ(e.target.value)} placeholder={t('post.partySearch')} />
            <select aria-label={t('post.partyList')} className={selectCls} value={partyId} onChange={(e) => setPartyId(e.target.value)}>
              <option value="">{t('post.choose')}</option>
              {(parties.data?.items ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
        ) : null}
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-desc`}>{t('post.description')}</Label>
          <Input id={`${id}-desc`} value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
        <p className="text-small text-muted-foreground">{t('post.final')}</p>
        {run.error ? (
          <Alert variant="destructive" role="alert">
            <AlertTitle>{run.error instanceof ApiError ? run.error.problem.title : t('failed')}</AlertTitle>
            {run.error instanceof ApiError && run.error.problem.detail ? <AlertDescription className="text-foreground!">{run.error.problem.detail}</AlertDescription> : null}
          </Alert>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t('cancel')}</Button>
          <Button disabled={!code || run.isPending} onClick={() => run.mutate()}>{run.isPending ? t('post.submitting') : t('post.submit')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
