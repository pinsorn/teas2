import { expect, test } from '@playwright/test';
import { counted } from './helpers/count';

test('1-line TI for a known customer with a usual item takes <= 5 actions (SP0 S3)', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  const u = counted(page);
  await u.click(page.getByRole('link', { name: 'สร้างใบกำกับภาษี' }));   // Home quick action
  await u.type(page.getByRole('combobox', { name: 'ลูกค้า' }), 'นาวา');
  await u.press('Enter');                                                 // pick customer, usual item prefilled
  await expect(page.getByRole('region', { name: 'ยังขาดอะไร' })).toHaveText(/ครบแล้ว/);
  await u.press('Control+Enter');                                         // open confirm
  await u.press('Enter');                                                 // issue
  await expect(page).toHaveURL(/\/sales\/tax-invoices\/[^/]+$/); // issued: the view route, not new/edit
  await expect(page.getByTestId('doc-number')).toHaveText(/^TI-\d{6}-\d{4}$/);
  await expect(page.locator('[data-status="issued"]').first()).toHaveText('ออกแล้ว');
  expect(u.count).toBeLessThanOrEqual(5);
});
