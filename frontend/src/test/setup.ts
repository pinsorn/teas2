import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

// vitest globals are off, so RTL's automatic cleanup never registers: unmount between tests.
afterEach(cleanup);
import th from '@/messages/th.json';

// next-intl shim: component tests resolve keys from th.json without a provider.
const lookup = (ns: string | undefined, key: string): unknown =>
  [...(ns ? ns.split('.') : []), ...key.split('.')].reduce<unknown>((a, k) => (a as Record<string, unknown> | undefined)?.[k], th);
vi.mock('next-intl', () => ({
  useTranslations: (ns?: string) => (key: string, values?: Record<string, string | number>) => {
    const m = lookup(ns, key);
    if (typeof m !== 'string') return `${ns ? `${ns}.` : ''}${key}`;
    return m.replace(/\{(\w+)\}/g, (_, k: string) => String(values?.[k] ?? `{${k}}`));
  },
  useLocale: () => 'th',
  NextIntlClientProvider: ({ children }: { children: unknown }) => children,
}));
