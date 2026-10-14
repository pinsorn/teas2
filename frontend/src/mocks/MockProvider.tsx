'use client';
import { useEffect, useState, type ReactNode } from 'react';

export function MockProvider({ children }: { children: ReactNode }) {
  const enabled = process.env.NEXT_PUBLIC_API_MOCKING === 'enabled';
  const [ready, setReady] = useState(!enabled);
  useEffect(() => {
    if (!enabled) return;
    import('./browser').then(({ worker }) => worker.start({ onUnhandledFrame: 'bypass', quiet: true })).then(() => setReady(true));
  }, [enabled]);
  return ready ? children : null;
}
