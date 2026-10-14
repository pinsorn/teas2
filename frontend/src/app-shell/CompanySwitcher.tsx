'use client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckIcon, ChevronsUpDownIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { endpoints } from '@/lib/api/endpoints';
import { qk } from '@/lib/query/keys';
import { useMe } from './useMe';

export function CompanySwitcher() {
  const t = useTranslations('shell.company');
  const qc = useQueryClient();
  const { me, isPending } = useMe();
  const switchTo = useMutation({
    mutationFn: endpoints.setActiveCompany,
    onSuccess: (next) => qc.setQueryData(qk.me(), next),
    onError: () => toast.error(t('switchFailed')),
  });

  if (isPending) return <Skeleton className="m-3 h-12" />;
  const active = me?.memberships.find((m) => m.companyId === me.activeCompanyId);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="m-3 flex min-h-12 items-center gap-2 rounded-lg border bg-background px-3 py-2 text-left text-sm outline-none hover:bg-muted">
        <span className="min-w-0 flex-1">
          <span className="block text-xs text-muted-foreground">{t('label')}</span>
          <span className="block truncate font-medium">{active?.companyName ?? t('none')}</span>
        </span>
        <ChevronsUpDownIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-60">
        <DropdownMenuLabel>{t('heading')}</DropdownMenuLabel>
        {me?.memberships.map((m) => (
          <DropdownMenuItem key={m.companyId} disabled={switchTo.isPending} onSelect={() => m.companyId !== me.activeCompanyId && switchTo.mutate(m.companyId)}>
            <span className="flex-1">{m.companyName}</span>
            {m.companyId === me.activeCompanyId && <CheckIcon className="size-4" aria-hidden />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
