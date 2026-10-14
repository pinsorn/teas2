'use client';
import { ErrorState } from '@/kit/states/ErrorState';

/** A page error inside the shell: sidebar, topbar and breadcrumbs stay, so the user can navigate away. `retry` re-fetches (stable since Next 16.3). */
export default function AppShellError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return <ErrorState error={error} onRetry={retry} />;
}
