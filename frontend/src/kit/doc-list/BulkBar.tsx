'use client';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { ApiError } from '@/lib/api/client';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

export interface BulkAction { key: string; label: string; permission: string; run: (ids: string[]) => Promise<void> }

/** Shown while rows are selected: the count, a clear button, and the bulk actions. An action the user lacks the permission for
 *  stays visible but disabled, and its tooltip names the missing permission. */
export function BulkBar({ ids, actions, permissions, onClear, onDone }: {
  ids: string[]; actions: BulkAction[]; permissions: string[]; onClear: () => void; onDone?: () => void;
}) {
  const t = useTranslations('docList');
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const run = async (a: BulkAction) => {
    setBusy(a.key); setFailed(null);
    try { await a.run(ids); onDone?.(); onClear(); } catch (e) { setFailed(e instanceof ApiError ? (e.problem.detail ?? e.problem.title) : t('bulkFailed')); } finally { setBusy(null); }
  };
  return (
    <TooltipProvider>
      <div role="region" aria-label={t('selected', { count: ids.length })}
        className="flex flex-wrap items-center gap-2 rounded-lg border bg-card px-3 py-2">
        <span role="status" className="font-medium tabular-nums">{t('selected', { count: ids.length })}</span>
        {actions.map((a) => {
          const allowed = permissions.includes(a.permission);
          const btn = (
            <Button size="sm" variant="outline" disabled={!allowed || busy !== null} onClick={() => run(a)}>{a.label}</Button>
          );
          return allowed ? <span key={a.key}>{btn}</span> : (
            <Tooltip key={a.key}>
              <TooltipTrigger asChild><span tabIndex={0}>{btn}</span></TooltipTrigger>
              <TooltipContent>{t('needsPermission', { permission: a.permission })}</TooltipContent>
            </Tooltip>
          );
        })}
        <Button size="sm" variant="ghost" onClick={onClear}>{t('clearSelection')}</Button>
        {failed ? <span role="alert" className="text-destructive">{failed}</span> : null}
      </div>
    </TooltipProvider>
  );
}
