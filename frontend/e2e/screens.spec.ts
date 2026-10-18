import { expect, test } from '@playwright/test';
import { SCREENS } from '../src/app/mock/screens/screens';
import { axeClean } from './helpers/axe';

// One test per CHUNK of index cards: the index grows with every group, and a single test walking all of it hit its own timeout on the slow CI runner
// (the timeout aborted a page.goto mid-flight: "net::ERR_ABORTED"). Chunks keep each test far below its limit however big the index gets.
const CHUNK = 15;
for (let from = 0; from < SCREENS.length; from += CHUNK) {
  test(`every built screen in the index opens without an error boundary (${from + 1}-${Math.min(from + CHUNK, SCREENS.length)})`, async ({ page }) => {
    await page.goto('/mock/screens');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible(); // the page mounts once the mock worker is ready
    const cards = page.locator('#built + ul > li');
    await expect(cards).toHaveCount(SCREENS.length);
    const links: string[] = [];
    for (let i = from; i < Math.min(from + CHUNK, SCREENS.length); i++) {
      links.push((await cards.nth(i).getByRole('link', { name: /^เปิด/ }).evaluate((a) => (a as HTMLAnchorElement).href)));
    }
    for (const href of links) {
      await page.goto(href);
      await expect(page.getByRole('heading', { level: 1 }).first(), href).toBeVisible(); // it rendered (not just "no error yet")
      await expect(page.getByText('Application error')).toHaveCount(0);
    }
  });
}

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
