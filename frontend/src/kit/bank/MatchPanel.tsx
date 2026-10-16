'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useMe } from '@/app-shell/useMe';
import type { BankLine } from '@/domain/types';
import { ApiError } from '@/lib/api/client';
import { endpoints } from '@/lib/api/endpoints';
import { formatDateBE, formatMoney } from '@/lib/format';
import { qk } from '@/lib/query/keys';

type Role = '' | 'BankFee' | 'RoundingDifference';

/** FN2: find the receipts / vouchers of this account a statement line stands for - suggestions first (exact cash, within 7 days), a search to widen - pick one or several (batch), optionally a share
 *  (a document split over lines) and a fee / rounding difference. The server judges every sum (`bank.match_amount` shows both sides); the browser adds nothing up. */
export function MatchPanel({ line, onClose }: { line: BankLine; onClose: () => void }) {
  const t = useTranslations('bank.reconcile');
  const qc = useQueryClient();
  const { me } = useMe();
  const id = useId();
  const company = me?.activeCompanyId ?? '';
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [share, setShare] = useState('');
  const [role, setRole] = useState<Role>('');
  const [diff, setDiff] = useState('');
  const incoming = !line.amount.startsWith('-');

  const cands = useQuery({ queryKey: qk.bankCandidates(company, line.id, q), queryFn: () => endpoints.bankCandidates(line.id, q || undefined), enabled: !!me });
  const run = useMutation({
    mutationFn: () => endpoints.matchBankLine(line.id, {
      docIds: picked,
      ...(picked.length === 1 && share ? { amounts: { [picked[0]]: share } } : {}),
      ...(role && diff ? { diff: { role, amount: role === 'BankFee' ? `-${diff.replace(/^-/, '')}` : diff } } : {}),
    }),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: [company] }); onClose(); },
  });
  const toggle = (docId: string, on: boolean) => setPicked((p) => (on ? [...p, docId] : p.filter((x) => x !== docId)));
  const items = cands.data?.items ?? [];

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent aria-describedby={undefined} className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader><DialogTitle>{t('match.title')}</DialogTitle></DialogHeader>
        <p className="tabular-nums text-body">
          {formatDateBE(line.date)} · {line.description} · <strong>{incoming ? '+' : '−'}{formatMoney(line.amount.replace('-', ''))}</strong>
        </p>
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-q`}>{t('match.search')}</Label>
          <Input id={`${id}-q`} value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('match.searchHint')} />
          <p className="text-small text-muted-foreground">{q ? t('match.searchResults') : t('match.suggestions')}</p>
        </div>
        {cands.isError ? (
          <Alert variant="destructive" role="alert"><AlertTitle>{cands.error instanceof ApiError ? cands.error.problem.title : t('failed')}</AlertTitle></Alert>
        ) : cands.isPending ? <p role="status" className="text-muted-foreground">{t('match.loading')}</p> : items.length === 0 ? (
          <p className="text-muted-foreground" data-testid="no-candidates">{q ? t('match.noneFound') : t('match.noSuggestion')}</p>
        ) : (
          <ul className="grid gap-2" aria-label={t('match.list')}>
            {items.map((c) => (
              <li key={c.docId} className="flex items-start gap-3 rounded-lg border p-3">
                <Checkbox id={`${id}-${c.docId}`} checked={picked.includes(c.docId)} onCheckedChange={(v) => toggle(c.docId, v === true)} aria-label={`${c.number}`} />
                <Label htmlFor={`${id}-${c.docId}`} className="grid flex-1 gap-0.5 font-normal">
                  <span className="font-medium">{c.number}{c.exact ? <span className="ms-2 rounded bg-secondary px-1.5 text-small">{t('match.exact')}</span> : null}</span>
                  <span className="text-small text-muted-foreground">{formatDateBE(c.documentDate)} · {c.partyName}</span>
                  <span className="tabular-nums text-small">{t('match.cash')} {formatMoney(c.cash)}{c.remaining !== c.cash ? ` · ${t('match.remaining')} ${formatMoney(c.remaining)}` : ''}</span>
                </Label>
              </li>
            ))}
          </ul>
        )}
        <fieldset className="grid gap-3 rounded-lg border p-3">
          <legend className="px-1 text-small">{t('match.options')}</legend>
          {picked.length === 1 ? (
            <div className="grid gap-1.5">
              <Label htmlFor={`${id}-share`}>{t('match.share')}</Label>
              <Input id={`${id}-share`} inputMode="decimal" value={share} onChange={(e) => setShare(e.target.value)} placeholder={t('match.shareHint')} />
            </div>
          ) : null}
          <div className="flex flex-wrap items-end gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor={`${id}-role`}>{t('match.diffRole')}</Label>
              <select id={`${id}-role`} value={role} onChange={(e) => setRole(e.target.value as Role)} className="h-(--ctl-h) rounded-lg border border-input bg-card px-3 text-body">
                <option value="">{t('match.noDiff')}</option>
                <option value="BankFee">{t('diff.BankFee')}</option>
                <option value="RoundingDifference">{t('diff.RoundingDifference')}</option>
              </select>
            </div>
            {role ? (
              <div className="grid gap-1.5">
                <Label htmlFor={`${id}-diff`}>{t('match.diffAmount')}</Label>
                <Input id={`${id}-diff`} inputMode="decimal" value={diff} onChange={(e) => setDiff(e.target.value)} className="w-40" />
              </div>
            ) : null}
          </div>
          <p className="text-small text-muted-foreground">{role === 'BankFee' ? t('match.feeHint') : role === 'RoundingDifference' ? t('match.roundingHint') : t('match.noDiffHint')}</p>
        </fieldset>
        {run.error ? (
          <Alert variant="destructive" role="alert">
            <AlertTitle>{run.error instanceof ApiError ? run.error.problem.title : t('failed')}</AlertTitle>
            {run.error instanceof ApiError && run.error.problem.detail ? <AlertDescription className="text-foreground!">{run.error.problem.detail}</AlertDescription> : null}
          </Alert>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t('cancel')}</Button>
          <Button disabled={!picked.length || run.isPending} onClick={() => run.mutate()}>{run.isPending ? t('match.submitting') : t('match.submit')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
