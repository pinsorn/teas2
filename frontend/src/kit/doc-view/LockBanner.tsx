'use client';
import { LockIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { Lock } from '@/domain/types';
import { Guarded } from './Guarded';

/** What an exit does: `onClick`, or `why` when the user cannot (the missing permission). No result = the exit is plain text. */
export type ExitAction = (lock: Lock, exit: string) => { onClick: () => void; why?: string } | undefined;

/** A locked document says why and offers every exit as a button (SP1 section 4: a lock without an exit is a bug). Amber = pending tokens. */
export function LockBanner({ locks, exitAction }: { locks: Lock[]; exitAction?: ExitAction }) {
  const t = useTranslations('docView.lock');
  if (!locks.length) return null;
  return (
    <TooltipProvider>
      <div role="status" aria-label={t('label')} data-screen-state="locked"
        className="flex gap-3 rounded-lg border border-(--color-status-pending-fg)/30 bg-(--color-status-pending-bg) p-3 text-body text-(--color-status-pending-fg)">
        <LockIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
        <div className="grid gap-2">
          {locks.map((l) => (
            <div key={`${l.kind}-${l.reason}`} className="grid gap-1.5">
              <p className="font-medium">{l.reason}</p>
              {l.exits.length ? (
                <>
                  <p className="text-small">{t('exits')}</p>
                  <ul className="flex flex-wrap gap-2">
                    {l.exits.map((e) => {
                      const a = exitAction?.(l, e);
                      return (
                        <li key={e}>
                          {a ? <Guarded why={a.why}>{(p) => <Button {...p} size="sm" variant="outline" className="bg-background text-foreground" onClick={a.onClick}>{e}</Button>}</Guarded> : e}
                        </li>
                      );
                    })}
                  </ul>
                </>
              ) : null}
            </div>
          ))}
        </div>
      </div>
    </TooltipProvider>
  );
}
