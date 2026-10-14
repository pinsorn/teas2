'use client';
import { CircleCheckIcon, CircleAlertIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { Ref } from 'react';
import type { MissingItem } from '@/domain/types';
import { cn } from '@/lib/utils';

/** "What is still missing": the server's `missing[]`, or "all set". Each gap jumps to its field. */
export function MissingSummary({ missing, pending, partyLabel, partyChosen, onJump, ref }: {
  missing?: MissingItem[]; pending: boolean; partyLabel?: string; partyChosen: boolean; onJump: (field: string) => void; ref?: Ref<HTMLElement>;
}) {
  const t = useTranslations('docEditor.missing');
  // The server's generic "pick a party" is shown with the document's own word (customer / vendor).
  const text = (m: MissingItem) => (m.field === 'header.partyId' && !partyChosen && partyLabel ? t('pickParty', { party: partyLabel }) : m.message);
  // No answer from the server yet: a plain note, not the region (the region always holds a real answer).
  if (!missing) return <p className="rounded-xl bg-card p-4 text-small text-muted-foreground ring-1 ring-foreground/10">{t('checking')}</p>;
  return (
    <section ref={ref} aria-label={t('title')} aria-busy={pending} tabIndex={-1}
      className={cn('grid gap-2 rounded-xl bg-card p-4 ring-1 ring-foreground/10', pending && 'opacity-60')}>
      <h2 className="text-section font-semibold">{t('title')}</h2>
      {missing.length === 0 ? (
        <p className="flex items-center gap-2 text-body"><CircleCheckIcon aria-hidden className="size-4 text-(--color-status-settled-fg)" />{t('done')}</p>
      ) : (
        <ul className="grid gap-1">
          {missing.map((m) => (
            <li key={`${m.field}:${m.message}`}>
              <button type="button" onClick={() => onJump(m.field)}
                className="flex items-start gap-2 rounded-md text-left text-body underline-offset-4 hover:underline">
                <CircleAlertIcon aria-hidden className="mt-1 size-4 shrink-0 text-(--color-status-pending-fg)" />{text(m)}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
