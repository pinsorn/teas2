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

test('F3 T9: table rules are the soft rule (header keeps the full rule); a keyboard-focused button keeps its ring', async ({ page }) => {
  await page.goto('/sales/tax-invoices');
  await expect(page.getByRole('row').nth(1)).toBeVisible();
  const colour = (sel: string) => page.locator(sel).first().evaluate((el) => getComputedStyle(el).borderBottomColor);
  expect(await colour('tbody tr')).toBe('rgb(236, 231, 223)'); // --color-rule-soft
  expect(await colour('thead tr')).toBe('rgb(215, 209, 199)'); // --color-rule
  await page.keyboard.press('Tab');
  const ring = await page.evaluate(() => { const s = getComputedStyle(document.activeElement!); return { w: s.outlineWidth, st: s.outlineStyle, shadow: s.boxShadow }; });
  expect(ring.st).toBe('solid');
  expect(ring.w).toBe('3px');
});

test('F3 T9: the command menu input group draws one outline, on the group, not a second box inside it', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.waitForLoadState('networkidle'); // the Ctrl+K listener is attached after hydration
  await page.keyboard.press('Control+k');
  const input = page.getByRole('combobox').first();
  await expect(input).toBeFocused();
  const o = await input.evaluate((el) => {
    const group = el.closest('[data-slot="input-group"]')!;
    const own = getComputedStyle(el), g = getComputedStyle(group);
    return { inner: own.outlineStyle === 'none' || own.outlineWidth === '0px', group: g.outlineStyle, groupW: g.outlineWidth };
  });
  expect(o.inner).toBe(true);
  expect(o.group).toBe('solid');
  expect(o.groupW).toBe('3px');
});
