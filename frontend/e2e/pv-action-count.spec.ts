import { expect, test } from '@playwright/test';
import { counted } from './helpers/count';

test('1-line PV with WHT for a known vendor takes <= 6 actions (SP0 S3)', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  const u = counted(page);
  await u.click(page.getByRole('link', { name: 'สร้างใบสำคัญจ่าย' }));   // Home quick action
  await u.type(page.getByRole('combobox', { name: 'ผู้ขาย' }), 'อนันต์');
  await u.press('Enter');                                                // vendor picked; usual line 5,000.00 with WHT SVC 3 %
  await expect(page.getByRole('region', { name: 'ยังขาดอะไร' })).toHaveText(/ครบแล้ว/);
  const totals = page.getByRole('region', { name: 'ยอดรวม' });
  await expect(totals).toContainText('150.00');                          // WHT = round(5,000.00 × 3 %)
  await expect(totals).toContainText('4,850.00');                        // paid = total − WHT (deduct)
  await u.press('Control+Enter');                                        // open confirm
  await u.press('Enter');                                                // issue
  await expect(page).toHaveURL(/\/purchases\/payment-vouchers\/[^/]+$/);
  await expect(page.getByTestId('doc-number')).toHaveText(/^PV-\d{6}-\d{4}$/);
  await page.getByRole('tab', { name: 'เอกสารที่เกี่ยวข้อง' }).click();
  await expect(page.getByRole('link', { name: /WT-\d{6}-\d{4}/ })).toHaveCount(1);
  expect(u.count).toBeLessThanOrEqual(6);
});
