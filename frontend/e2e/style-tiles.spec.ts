import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

for (const tile of ['a', 'b', 'c']) {
  test(`tile ${tile} renders four surfaces and passes axe`, async ({ page }) => {
    await page.goto(`/style-tiles#${tile}`);
    for (const name of ['ตัวอักษรและสี', 'รายการใบกำกับภาษี', 'สร้างใบกำกับภาษี', 'ตัวอย่างกระดาษ A4']) {
      await expect(page.getByRole('heading', { name })).toBeVisible();
    }
    const r = await new AxeBuilder({ page }).include(`[data-tile="${tile}"]`).analyze();
    expect(r.violations.filter((v) => ['serious', 'critical'].includes(v.impact ?? ''))).toEqual([]);
  });
}
