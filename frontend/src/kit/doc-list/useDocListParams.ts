'use client';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef } from 'react';

export const FILTER_KEYS = ['status', 'q', 'from', 'to', 'view', 'overdue', 'outstanding', 'agent'] as const;
export type DocListFilters = Partial<Record<(typeof FILTER_KEYS)[number], string>>;

/** Filters live in the URL (shareable, survives reload). Reads useSearchParams, so the page must wrap DocList in <Suspense>.
 *  The paging cursor is deliberately not part of the URL: any filter change changes the query key, which restarts paging. */
export function useDocListParams() {
  const sp = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const filters: DocListFilters = {};
  for (const k of FILTER_KEYS) { const v = sp.get(k); if (v) filters[k] = v; }

  // A debounced caller (the search box) must patch the filters as they are NOW, not as they were when the key was pressed.
  const live = useRef(filters);
  useEffect(() => { live.current = filters; });

  /** Replaces the whole filter set (keys left out are cleared). */
  const setFilters = (next: DocListFilters) => {
    const u = new URLSearchParams();
    for (const k of FILTER_KEYS) if (next[k]) u.set(k, next[k]!);
    const s = u.toString();
    router.replace(s ? `${pathname}?${s}` : pathname);
  };
  const patch = (p: DocListFilters) => setFilters({ ...live.current, view: undefined, ...p });
  return { filters, setFilters, patch };
}
