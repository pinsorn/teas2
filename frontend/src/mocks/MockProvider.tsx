'use client';
import { TriangleAlertIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useState, type ReactNode } from 'react';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { applyUrlSettings } from './settings';

export function MockProvider({ children }: { children: ReactNode }) {
  const t = useTranslations('state');
  const enabled = process.env.NEXT_PUBLIC_API_MOCKING === 'enabled';
  const [ready, setReady] = useState(!enabled);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    applyUrlSettings(window.location.search);
    import('./browser')
      .then(({ worker }) => worker.start({ onUnhandledFrame: 'bypass', quiet: true }))
      .then(() => setReady(true), () => setFailed(true)); // a blocked / stale service worker must not be a blank page
  }, [enabled]);
  if (failed) {
    return (
      <div className="p-4 md:p-6">
        <Alert variant="destructive">
          <TriangleAlertIcon aria-hidden />
          <AlertTitle>{t('mockFailedTitle')}</AlertTitle>
          <AlertDescription className="text-foreground!">{t('mockFailedBody')}</AlertDescription>
          <AlertAction><Button size="sm" variant="outline" onClick={() => window.location.reload()}>{t('retry')}</Button></AlertAction>
        </Alert>
      </div>
    );
  }
  return ready ? children : null;
}
