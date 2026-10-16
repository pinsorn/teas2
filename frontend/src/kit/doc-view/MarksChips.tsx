import { useTranslations } from 'next-intl';
import type { DocMarks } from '@/domain/types';
import { cn } from '@/lib/utils';

// Tones come only from tokens.css (--color-status-*); a chip always carries its text label.
const TONE = {
  accepted: 'text-(--color-status-approved-fg) bg-(--color-status-approved-bg)',
  delivered: 'text-(--color-status-approved-fg) bg-(--color-status-approved-bg)',
  sent: 'text-(--color-status-approved-fg) bg-(--color-status-approved-bg)',
  rejected: 'text-(--color-status-overdue-fg) bg-(--color-status-overdue-bg)',
  closed: 'text-(--color-status-cancelled-fg) bg-(--color-status-cancelled-bg)',
} as const;
const ORDER = ['accepted', 'rejected', 'delivered', 'sent', 'closed'] as const;

/** The marks of a document (customer accepted / rejected, delivered, sent, closed) as chips next to its status; `data-mark` names the mark. */
export function MarksChips({ marks, className }: { marks?: DocMarks; className?: string }) {
  const t = useTranslations('docView.marks');
  const shown = ORDER.filter((k) => marks?.[k]);
  if (!shown.length) return null;
  return (
    <>
      {shown.map((k) => {
        const m = marks![k]!;
        const reason = 'reason' in m ? m.reason : undefined;
        return (
          <span key={k} data-mark={k} title={reason ? t('rejectedWhy', { reason }) : undefined}
            className={cn('inline-flex h-6 items-center rounded-md px-2.5 text-small font-medium whitespace-nowrap', TONE[k], className)}>
            {t(k)}
          </span>
        );
      })}
    </>
  );
}
