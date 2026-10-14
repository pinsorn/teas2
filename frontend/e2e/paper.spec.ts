import { expect, test } from '@playwright/test';

test('print route renders the paper only, signals ready', async ({ page }) => {
  await page.goto('/');
  await page.waitForTimeout(1000);
  const id = await page.evaluate(async () => {
    const list = await (await fetch('/bff/v1/docs/TI?status=issued&limit=1')).json();
    return list.items[0].id as string;
  });
  await page.goto(`/print/TI/${id}`);
  await page.waitForSelector('[data-paper-ready="true"]');
  await expect(page.locator('[data-paper-page]')).toHaveCount(1);
  await expect(page.getByRole('navigation')).toHaveCount(0); // no app shell
  const box = await page.locator('[data-paper-page]').boundingBox();
  expect(Math.round(box!.width)).toBe(794);
  expect(Math.round(box!.height)).toBe(1123);
  await page.emulateMedia({ media: 'print' });
  await expect(page.locator('.paper-probe')).toBeHidden();
});

test('a long invoice paginates on the real measured path', async ({ page }) => {
  await page.goto('/');
  await page.waitForTimeout(1000);
  const id = await page.evaluate(async () => {
    const j = (m: string, p: string, b?: unknown, h: Record<string, string> = {}) =>
      fetch(p, { method: m, headers: { 'content-type': 'application/json', ...h }, body: b ? JSON.stringify(b) : undefined }).then((r) => r.json());
    const party = (await j('GET', '/bff/v1/parties?kind=customer&limit=20')).items.find((p: { taxId?: string; vatRegistered: boolean }) => p.taxId && p.vatRegistered);
    const lines = Array.from({ length: 45 }, (_, i) => ({ id: 'l' + i, description: 'งานออกแบบ ' + (i + 1), qty: '1', unit: 'งาน', unitPrice: '1000.00', taxCode: 'S7' }));
    const d = await j('POST', '/bff/v1/docs/TI', { header: { partyId: party.id, documentDate: '2026-10-14' }, lines }, { 'Idempotency-Key': 'e2e-long' });
    return (await j('POST', `/bff/v1/docs/TI/${d.id}/issue`, { version: d.version })).id as string;
  });
  await page.goto(`/print/TI/${id}`);
  await page.waitForSelector('[data-paper-ready="true"]');
  const n = await page.locator('[data-paper-page]').count();
  expect(n).toBeGreaterThan(1);
  await expect(page.locator('[data-paper-page]').last()).toContainText(`หน้า ${n}/${n}`);
  await expect(page.locator('[data-paper-page]').getByText('ผู้มีอำนาจลงนาม')).toHaveCount(1);
});
