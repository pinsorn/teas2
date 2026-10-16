import { expect, test } from '@playwright/test';
import { axeClean } from './helpers/axe';

test('every built screen in the index opens without an error boundary', async ({ page }) => {
  test.setTimeout(120_000); // one navigation per screen of the index: the index grows with every group
  await page.goto('/mock/screens');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible(); // the page mounts once the mock worker is ready
  await expect(page.getByRole('link', { name: /^เปิด/ }).first()).toBeVisible();
  const links = await page.getByRole('link', { name: /^เปิด/ }).evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).href));
  expect(links.length).toBeGreaterThan(5);
  for (const href of links) {
    await page.goto(href);
    await expect(page.getByRole('heading', { level: 1 }).first(), href).toBeVisible(); // it rendered (not just "no error yet")
    await expect(page.getByText('Application error')).toHaveCount(0);
  }
});

test('the index passes axe, lists the SP1c screens, and a ?state= link sets the toolbar state', async ({ page }) => {
  await page.goto('/mock/screens');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible(); // mounted = the mock worker is ready
  await expect(page.getByText('รอ SP1c').first()).toBeVisible();
  await axeClean(page);
  const card = page.getByRole('listitem').filter({ has: page.getByRole('heading', { name: 'ใบกำกับภาษี รายการ' }) });
  await card.getByRole('link', { name: 'ไม่มีข้อมูล' }).click(); // tax-invoice list, empty
  await expect(page).toHaveURL(/state=empty/);
  // applyUrlSettings runs in an effect after the new page mounts: poll for the applied state instead of reading it once
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('teas2.mock.settings.v1') ?? '{}').screenState)).toBe('empty');
});
