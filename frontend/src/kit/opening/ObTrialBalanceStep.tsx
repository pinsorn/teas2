'use client';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useMe } from '@/app-shell/useMe';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import type { ComputeResult, DocHeader, DocLine } from '@/domain/types';
import { endpoints } from '@/lib/api/endpoints';
import { AccountLineGrid } from '../doc-editor/AccountLineGrid';

/** Step 1: the cut-off date and the trial balance at it, as account lines. The accounts come from the server (a controlled account is allowed here - it must tie to its step; 3900 is the system's). */
export function ObTrialBalanceStep({ header, onHeader, lines, onLines, compute, computing }: {
  header: DocHeader; onHeader: (h: DocHeader) => void; lines: DocLine[]; onLines: (l: DocLine[]) => void; compute?: ComputeResult; computing: boolean;
}) {
  const t = useTranslations('opening');
  const { me } = useMe();
  const accounts = useQuery({ queryKey: [me?.activeCompanyId ?? '', 'opening-accounts'], queryFn: endpoints.openingAccounts, enabled: !!me });
  return (
    <div className="grid gap-4">
      <div className="grid gap-3 md:grid-cols-[14rem_1fr]">
        <div className="grid gap-1">
          <Label htmlFor="ob-cutoff">{t('cutoff')}</Label>
          <Input id="ob-cutoff" type="date" value={header.documentDate} onChange={(e) => onHeader({ ...header, documentDate: e.target.value })} />
          <p className="text-small text-muted-foreground">{t('cutoffHint')}</p>
        </div>
        <div className="grid gap-1">
          <Label htmlFor="ob-notes">{t('notes')}</Label>
          <Textarea id="ob-notes" rows={2} value={header.notes ?? ''} onChange={(e) => onHeader({ ...header, notes: e.target.value || undefined })} />
        </div>
      </div>
      <p className="text-body text-muted-foreground">{t('tbHint')}</p>
      <AccountLineGrid lines={lines} onChange={onLines} accounts={accounts.data ?? []} balance={compute?.balance} computing={computing} plug />
    </div>
  );
}
