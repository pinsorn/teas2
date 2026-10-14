import { expect, test } from '@playwright/test';
import { axeClean } from './helpers/axe';

test.beforeEach(async ({ page }) => { await page.goto('/'); await page.evaluate(() => localStorage.clear()); });

test('the TI list renders through the generic route', async ({ page }) => {
  await page.goto('/sales/tax-invoices');
  await expect(page.getByRole('heading', { level: 1, name: 'ใบกำกับภาษี' })).toBeVisible();
  await expect(page).toHaveTitle(/ใบกำกับภาษี/);
  await axeClean(page);
});
test('a nav route not built yet shows the coming-in-SP1c panel, not a 404', async ({ page }) => {
  await page.goto('/accounting/opening-balances');
  await expect(page.getByRole('heading', { level: 1, name: 'ยอดยกมา' })).toBeVisible();
});
// With NEXT_PUBLIC_API_MOCKING=enabled MockProvider renders null on the server, so the shell streams first and the HTTP status is
// always 200 (see troubles-wiki). The user-visible contract is the not-found page, marked noindex by Next.
test('an unknown route is the not-found page, not a blank or a stub', async ({ page }) => {
  await page.goto('/sales/no-such-thing');
  await expect(page.getByText('ไม่พบหน้าที่ต้องการ')).toBeVisible();
  await expect(page.locator('meta[name="robots"][content*="noindex"]')).toHaveCount(1);
});
test('non-VAT company: TI routes say why they are unavailable', async ({ page }) => {
  await page.goto('/sales/tax-invoices/new?company=nonvat');
  await expect(page.getByText('ใช้ได้เฉพาะบริษัทที่จดทะเบียน VAT')).toBeVisible();
});
