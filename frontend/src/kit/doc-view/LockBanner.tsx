import { LockIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { Lock } from '@/domain/types';

/** A locked document says why and which ways forward exist; the disabled actions point here. */
export function LockBanner({ locks }: { locks: Lock[] }) {
  const t = useTranslations('docView.lock');
  if (!locks.length) return null;
  return (
    <div role="status" aria-label={t('label')} className="flex gap-3 rounded-lg border border-border bg-muted p-3 text-body">
      <LockIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
      <div className="grid gap-2">
        {locks.map((l) => (
          <div key={`${l.kind}-${l.reason}`}>
            <p className="font-medium">{l.reason}</p>
            {l.exits.length ? (
              <>
                <p className="text-small text-muted-foreground">{t('exits')}</p>
                <ul className="list-disc pl-5">{l.exits.map((e) => <li key={e}>{e}</li>)}</ul>
              </>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
