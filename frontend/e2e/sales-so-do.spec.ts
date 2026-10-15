import { expect, test } from '@playwright/test';
import { fixtureId } from './helpers/fixtures';
import { screenContract } from './helpers/screen-contract';

screenContract({ name: 'SO list', path: '/sales/sales-orders', heading: 'ใบสั่งขาย', company: 'both', states: ['empty', 'loading', 'error', 'forbidden'], forbiddenRole: 'admin', roles: ['operator', 'accountant'] });
screenContract({ name: 'SO view', path: async (p) => `/sales/sales-orders/${await fixtureId(p, 'soPartlyDelivered')}`, heading: /SO-\d{6}-\d{4}/, company: 'vat', otherCompany: 'not-found', states: ['loading', 'error', 'forbidden'] });
screenContract({ name: 'DO list', path: '/sales/delivery-orders', heading: 'ใบส่งของ', company: 'both', states: ['empty', 'loading', 'error', 'forbidden'], forbiddenRole: 'admin', roles: ['operator', 'accountant'] });
screenContract({ name: 'DO view', path: async (p) => `/sales/delivery-orders/${await fixtureId(p, 'doDelivered')}`, heading: /DO-\d{6}-\d{4}/, company: 'vat', otherCompany: 'not-found', states: ['loading', 'error', 'forbidden'] });

test('SO partly delivered shows "ส่งแล้ว 10/30"; close remainder needs a reason; then convert is disabled with the exit', async ({ page }) => {
  await page.goto('/'); const id = await fixtureId(page, 'soPartlyDelivered');
  await page.goto(`/sales/sales-orders/${id}`);
  await expect(page.getByText('ส่งแล้ว 10/30')).toBeVisible();
  await page.getByRole('button', { name: 'ปิดยอดคงเหลือ' }).click();
  const dlg = page.getByRole('alertdialog', { name: 'ปิดยอดคงเหลือ' });
  await expect(dlg.getByRole('button', { name: 'ยืนยันปิดยอดคงเหลือ' })).toBeDisabled();
  await dlg.getByLabel('เหตุผล').fill('ลูกค้าไม่รับส่วนที่เหลือ');
  await dlg.getByRole('button', { name: 'ยืนยันปิดยอดคงเหลือ' }).click();
  await expect(page.locator('[data-mark="closed"]')).toBeVisible();
  await expect(page.getByRole('button', { name: 'แปลงเป็น…' })).toBeDisabled();
  await expect(page.getByText(/แก้ไขเอกสาร \(ฉบับแก้ไข\) เพื่อเปิดยอดคงเหลือใหม่/)).toBeVisible(); // the exit
  await expect(page.getByText('ส่งแล้ว 10/30 (ปิดยอดคงเหลือ)')).toBeVisible();
  await expect(page.getByRole('button', { name: 'ปิดยอดคงเหลือ' })).toHaveCount(0);
});

test('a closed SO is shown closed from the start, with its reason', async ({ page }) => {
  await page.goto('/'); const id = await fixtureId(page, 'soClosed');
  await page.goto(`/sales/sales-orders/${id}`);
  await expect(page.locator('[data-mark="closed"]')).toBeVisible();
  await expect(page.getByText(/ลูกค้าขอยกเลิกส่วนที่เหลือ/).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'แปลงเป็น…' })).toBeDisabled();
});

test('SO → DO: the delivery lands in the DO editor, the SO list shows its progress, and the delivered mark is status-only', async ({ page }) => {
  await page.goto('/'); const id = await fixtureId(page, 'soPartlyDelivered');
  await page.goto('/sales/sales-orders');
  await expect(page.getByRole('row', { name: /ส่งแล้ว 10\/30/ })).toBeVisible(); // the progress column
  await page.goto(`/sales/sales-orders/${id}`);
  await page.getByRole('button', { name: 'แปลงเป็น…' }).click();
  const dlg = page.getByRole('dialog', { name: /แปลงใบสั่งขาย/ });
  await dlg.getByLabel('เอกสารปลายทาง').selectOption('DO');
  await dlg.getByRole('button', { name: 'สร้างใบส่งของ' }).click();
  await expect(page).toHaveURL(/\/sales\/delivery-orders\/[^/]+\/edit$/);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('ใบส่งของ'); // a working DO editor
  const did = await fixtureId(page, 'doDelivered');
  await page.goto(`/sales/delivery-orders/${did}`);
  await expect(page.locator('[data-mark="delivered"]')).toBeVisible();
  await expect(page.getByRole('button', { name: 'ส่งของแล้ว' })).toHaveCount(0); // already marked
  await expect(page.getByText('วางบิลแล้ว 0/2')).toBeVisible();
});

test('a DO offers TI / IV only (D-07: no billing note from a delivery order)', async ({ page }) => {
  await page.goto('/'); const did = await fixtureId(page, 'doDelivered');
  await page.goto(`/sales/delivery-orders/${did}`);
  await page.getByRole('button', { name: 'แปลงเป็น…' }).click();
  const options = await page.getByRole('dialog').getByLabel('เอกสารปลายทาง').locator('option').allTextContents();
  expect(options).toEqual(['ใบกำกับภาษี']);
});

test('non-VAT: the SO converted from the accepted QT and its delivered DO are readable', async ({ page }) => {
  await page.goto('/?company=nonvat'); const sid = await fixtureId(page, 'nsoIssued');
  await page.goto(`/sales/sales-orders/${sid}`);
  await expect(page.getByText('ส่งครบ')).toBeVisible();
  const did = await fixtureId(page, 'ndoDelivered');
  await page.goto(`/sales/delivery-orders/${did}`);
  await expect(page.locator('[data-mark="delivered"]')).toBeVisible();
});

test('SO prints with its own title and no tax-invoice wording', async ({ page }) => {
  await page.goto('/'); const id = await fixtureId(page, 'soPartlyDelivered');
  await page.goto(`/print/SO/${id}`);
  await expect(page.locator('[data-paper-ready="true"]')).toBeVisible();
  await expect(page.locator('h2').first()).toHaveText('ใบสั่งขาย');
  await expect(page.locator('[data-paper-page]').first().getByText('กำหนดส่ง')).toBeVisible();
  await expect(page.getByText('ใบกำกับภาษี')).toHaveCount(0);
});
