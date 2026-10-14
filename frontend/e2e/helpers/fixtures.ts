import { expect, type Page } from '@playwright/test';

/** Resolves a named fixture document id (src/mocks/fixtures/ids.ts) against the mock state in the page.
 *  The mock worker starts after hydration, so the request is retried until the worker answers (anything else is the Next 404 page). */
export async function fixtureId(page: Page, key: string): Promise<string> {
  if (page.url() === 'about:blank') await page.goto('/');
  let ids: Record<string, string> | undefined;
  await expect.poll(async () => {
    ids = await page.evaluate(async () => {
      const r = await fetch('/bff/v1/mock/fixtures');
      return r.ok && (r.headers.get('content-type') ?? '').includes('json') ? ((await r.json()) as Record<string, string>) : undefined;
    });
    return ids !== undefined;
  }, { message: 'mock worker did not answer /bff/v1/mock/fixtures' }).toBe(true);
  const id = ids![key];
  if (!id) throw new Error(`unknown fixture key "${key}" (have: ${Object.keys(ids!).join(', ')})`);
  return id;
}
