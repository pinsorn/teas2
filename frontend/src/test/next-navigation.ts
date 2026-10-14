import { vi } from 'vitest';

let params = new URLSearchParams();
const go = (u: string) => { params = new URL(u, 'http://localhost').searchParams; };
const router = { push: vi.fn(go), replace: vi.fn(go), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() };
export const useRouter = () => router;
export const useSearchParams = () => params;
export const usePathname = () => '/';
export const notFound = () => { throw new Error('notFound'); };
export const __setSearch = (s: string) => { params = new URLSearchParams(s); };
