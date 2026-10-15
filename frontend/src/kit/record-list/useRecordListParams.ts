'use client';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef } from 'react';

export type ActiveFilter = 'true' | 'false' | 'all';
export interface RecordListParams { q: string; active: ActiveFilter }

/** Search text and the active filter live in the URL (shareable, survives reload). Reads useSearchParams, so the page wraps the list in <Suspense>. */
export function useRecordListParams() {
  const sp = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const raw = sp.get('active');
  const params: RecordListParams = { q: sp.get('q') ?? '', active: raw === 'false' || raw === 'all' ? raw : 'true' };
  // The debounced search box patches the params as they are NOW, not as they were when the key was pressed.
  const live = useRef(params);
  useEffect(() => { live.current = params; });
  const patch = (p: Partial<RecordListParams>) => {
    const n = { ...live.current, ...p };
    const u = new URLSearchParams();
    if (n.q) u.set('q', n.q);
    if (n.active !== 'true') u.set('active', n.active);
    const s = u.toString();
    router.replace(s ? `${pathname}?${s}` : pathname);
  };
  return { params, patch };
}
