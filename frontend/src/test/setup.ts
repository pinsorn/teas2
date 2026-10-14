import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

// vitest globals are off, so RTL's automatic cleanup never registers: unmount between tests.
afterEach(cleanup);
import th from '@/messages/th.json';

// next-intl: component tests use the REAL translator over th.json, strict: a missing key or argument throws (no silent key echo).
vi.mock('next-intl', async (orig) => {
  const m = await orig<typeof import('next-intl')>();
  return {
    ...m,
    useTranslations: (ns?: string) => m.createTranslator({ locale: 'th', messages: th, namespace: ns as never, onError: (e) => { throw e; } }),
    useLocale: () => 'th',
    NextIntlClientProvider: ({ children }: { children: unknown }) => children,
  };
});
