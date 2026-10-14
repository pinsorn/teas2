'use client';
import { ErrorState } from '@/kit/states/ErrorState';

/** Render errors below the root layout: the app's own error state with retry, never the bare Next page. */
export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="mx-auto max-w-2xl p-4 md:p-6">
      <ErrorState error={error} onRetry={reset} />
    </main>
  );
}
