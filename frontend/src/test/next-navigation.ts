import { useSyncExternalStore } from 'react';
import { vi } from 'vitest';

let params = new URLSearchParams();
const subs = new Set<() => void>();
const set = (p: URLSearchParams) => { params = p; subs.forEach((f) => f()); };
const go = (u: string) => set(new URL(u, 'http://localhost').searchParams);
const router = { push: vi.fn(go), replace: vi.fn(go), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() };
export const useRouter = () => router;
/** Subscribes like Next's hook: a push / replace (or a test's `__setSearch`, i.e. back / forward) re-renders the readers. */
export const useSearchParams = () => useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f); }; }, () => params, () => params);
export const usePathname = () => '/';
export const notFound = () => { throw new Error('notFound'); };
export const __setSearch = (s: string) => set(new URLSearchParams(s));
