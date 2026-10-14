import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

test('style guide shows every status chip and passes axe', async ({ page }) => {
  await page.goto('/style-guide');
  for (const s of ['ร่าง', 'รออนุมัติ', 'อนุมัติแล้ว', 'ออกแล้ว', 'ชำระบางส่วน', 'ชำระครบ', 'ยกเลิก', 'ถูกแทนที่']) {
    await expect(page.getByText(s, { exact: true }).first()).toBeVisible();
  }
  const r = await new AxeBuilder({ page }).analyze();
  expect(r.violations.filter((v) => ['serious', 'critical'].includes(v.impact ?? ''))).toEqual([]);
});
