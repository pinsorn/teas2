import { expect, type Page } from '@playwright/test';

/** Resolves a named fixture document id (src/mocks/fixtures/ids.ts) against the mock state in the page.
 *  The mock worker starts after hydration, so the request is retried until the worker answers (anything else is the Next 404 page). */
export async function fixtureId(page: Page, key: string): Promise<string> {
  if (page.url() === 'about:blank') await page.goto('/');
  let ids: Record<string, string> | undefined;
  await expect.poll(async () => {
    // a navigation / reload in flight destroys the execution context: treat it as "not yet" and poll again once the page settled
    await page.waitForLoadState('domcontentloaded').catch(() => undefined);
    const r = await page.evaluate(async () => {
      const res = await fetch('/bff/v1/mock/fixtures');
      const type = res.headers.get('content-type') ?? '';
      return { ok: res.ok, status: res.status, problem: type.includes('problem+json'), json: type.includes('json') ? await res.json() : undefined };
    }).catch((e: unknown) => {
      if (/Execution context was destroyed|navigation|Target closed|detached/i.test(String(e))) return undefined;
      throw e;
    });
    if (!r) return false;
    if (r.problem) throw new Error(`/bff/v1/mock/fixtures failed (${r.status}): ${(r.json as { title?: string }).title}`); // handler answered: do not keep polling
    ids = r.ok ? (r.json as Record<string, string>) : undefined; // anything else is the Next 404 page: the worker is not up yet
    return ids !== undefined;
  }, { message: 'mock worker did not answer /bff/v1/mock/fixtures' }).toBe(true);
  const id = ids![key];
  if (!id) throw new Error(`unknown fixture key "${key}" (have: ${Object.keys(ids!).join(', ')})`);
  return id;
}
