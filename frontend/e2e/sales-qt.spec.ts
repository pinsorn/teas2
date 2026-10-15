import { expect, test } from '@playwright/test';
import { fixtureId } from './helpers/fixtures';
import { screenContract } from './helpers/screen-contract';

screenContract({ name: 'QT list', path: '/sales/quotations', heading: 'ใบเสนอราคา', company: 'both', states: ['empty', 'loading', 'error', 'forbidden'], forbiddenRole: 'admin', roles: ['operator', 'accountant'] });
screenContract({ name: 'QT view', path: async (p) => `/sales/quotations/${await fixtureId(p, 'qtIssued')}`, heading: /QT-\d{6}-\d{4}/, company: 'vat', otherCompany: 'not-found', states: ['loading', 'error', 'forbidden'] });

test('accept → convert 1 of 2 lines to SO → remaining shown on the QT chain', async ({ page }) => {
  await page.goto('/'); const id = await fixtureId(page, 'qtIssued');
  await page.goto(`/sales/quotations/${id}`);
  await page.getByRole('button', { name: 'แปลงเป็น…' }).click();
  const dlg = page.getByRole('dialog', { name: /แปลงใบเสนอราคา/ });
  await dlg.getByLabel('เอกสารปลายทาง').selectOption('SO');
  await dlg.getByRole('spinbutton').nth(1).fill('0');
  await dlg.getByRole('button', { name: 'สร้างใบสั่งขาย' }).click();
  await expect(page).toHaveURL(/\/sales\/sales-orders\/[^/]+\/edit$/);
  await page.goto(`/sales/quotations/${id}`);
  await expect(page.locator('[data-mark="accepted"]')).toBeVisible();
  // the QT's chain shows the new draft SO and how much of the QT it took
  await page.getByRole('tab', { name: 'เอกสารที่เกี่ยวข้อง' }).click();
  const chain = page.getByRole('region', { name: 'เอกสารที่เกี่ยวข้อง' });
  await expect(chain.getByText(/แปลงไปเป็น/)).toBeVisible();
  await expect(chain.getByText('10/30')).toBeVisible(); // 10 of 30 units converted (line 1 only)
});

test('accepting a draft-free issued QT: the customer-accepted mark is recorded without a revision', async ({ page }) => {
  await page.goto('/'); const id = await fixtureId(page, 'qtRevised');
  await page.goto(`/sales/quotations/${id}`);
  await expect(page.locator('[data-mark]')).toHaveCount(0);
  await page.getByRole('button', { name: 'ลูกค้าตอบรับ' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'บันทึก' }).click();
  await expect(page.locator('[data-mark="accepted"]')).toBeVisible();
  await expect(page.getByText('แก้ไขแล้ว 1 ครั้ง')).toBeVisible(); // still revision 1
});

test('reject needs a reason and blocks conversion with an exit', async ({ page }) => {
  await page.goto('/'); const id = await fixtureId(page, 'qtRejected');
  await page.goto(`/sales/quotations/${id}`);
  await expect(page.locator('[data-mark="rejected"]')).toContainText('ปฏิเสธ');
  await expect(page.getByRole('button', { name: 'แปลงเป็น…' })).toBeDisabled();
  await expect(page.getByText(/แก้ไขเป็นฉบับใหม่หรือคัดลอกเป็นใบใหม่/)).toBeVisible();
});

test('rejecting a QT asks for a reason first', async ({ page }) => {
  await page.goto('/'); const id = await fixtureId(page, 'qtRevised');
  await page.goto(`/sales/quotations/${id}`);
  await page.getByRole('button', { name: 'ลูกค้าปฏิเสธ' }).click();
  const dlg = page.getByRole('alertdialog');
  await expect(dlg.getByRole('button', { name: 'บันทึก' })).toBeDisabled();
  await dlg.getByLabel('เหตุผลที่ลูกค้าปฏิเสธ').fill('งบไม่พอ');
  await dlg.getByRole('button', { name: 'บันทึก' }).click();
  await expect(page.locator('[data-mark="rejected"]')).toContainText('ปฏิเสธ');
  await expect(page.getByRole('button', { name: 'แปลงเป็น…' })).toBeDisabled();
});

test('non-VAT QT prints without VAT', async ({ page }) => {
  await page.goto('/?company=nonvat'); const id = await fixtureId(page, 'nqtIssued');
  await page.goto(`/print/QT/${id}`);
  await expect(page.locator('[data-paper-ready="true"]')).toBeVisible();
  await expect(page.getByText('ภาษีมูลค่าเพิ่ม')).toHaveCount(0);
});
