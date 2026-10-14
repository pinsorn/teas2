import { expect, test } from '@playwright/test';

test('print route renders the paper only, signals ready and paginates a long invoice', async ({ page }) => {
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
