'use client';
import { ErrorState } from '@/kit/states/ErrorState';

/** Failures above the app shell (root layout level; page errors are caught by (app)/error.tsx, which keeps the shell). `retry` re-fetches, `reset` would only re-render: the app's own error state with retry, never the bare Next page. */
export default function AppError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <main className="mx-auto max-w-2xl p-4 md:p-6">
      <ErrorState error={error} onRetry={retry} />
    </main>
  );
}
