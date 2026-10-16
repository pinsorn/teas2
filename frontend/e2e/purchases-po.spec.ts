import { expect, test } from '@playwright/test';
import { fixtureId } from './helpers/fixtures';
import { screenContract } from './helpers/screen-contract';

screenContract({ name: 'PO list', path: '/purchases/purchase-orders', heading: 'ใบสั่งซื้อ', company: 'both', states: ['empty', 'loading', 'error', 'forbidden'], forbiddenRole: 'admin', roles: ['operator', 'accountant'] });
screenContract({ name: 'PO view', path: async (p) => `/purchases/purchase-orders/${await fixtureId(p, 'poSent')}`, heading: /PO-\d{6}-\d{4}/, company: 'vat', otherCompany: 'not-found', states: ['loading', 'error', 'forbidden'] });

const BASE = '/purchases/purchase-orders';

test('PO: mark sent records a status-only chip with an activity entry, then the button goes away', async ({ page }) => {
  await page.goto('/'); const id = await fixtureId(page, 'poPartlyBilled');
  await page.goto(`${BASE}/${id}`);
  await expect(page.locator('[data-mark]')).toHaveCount(0);
  await page.getByRole('button', { name: 'บันทึกว่าส่งให้ผู้ขายแล้ว' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'บันทึก' }).click();
  await expect(page.locator('[data-mark="sent"]')).toBeVisible();
  await expect(page.getByRole('button', { name: 'บันทึกว่าส่งให้ผู้ขายแล้ว' })).toHaveCount(0);
  await expect(page.getByText('รับวางบิลแล้ว 0/140')).toBeVisible(); // status only: nothing received, no new document
  await page.getByRole('tab', { name: 'กิจกรรม' }).click();
  await expect(page.getByRole('tabpanel', { name: 'กิจกรรม' }).getByText('ส่งให้ผู้ขายแล้ว')).toBeVisible();
});

test('PO sent fixture: the chip is there from the start and the mark button is not offered', async ({ page }) => {
  await page.goto('/'); const id = await fixtureId(page, 'poSent');
  await page.goto(`${BASE}/${id}`);
  await expect(page.locator('[data-mark="sent"]')).toBeVisible();
  await expect(page.getByRole('button', { name: 'บันทึกว่าส่งให้ผู้ขายแล้ว' })).toHaveCount(0);
});

test('PO list shows the receiving progress and the marks columns', async ({ page }) => {
  await page.goto(BASE);
  await expect(page.getByRole('row', { name: /รับวางบิลแล้ว 0\/140/ })).toBeVisible();
  await expect(page.getByRole('row', { name: /รับวางบิลแล้ว 0\/6 \(ปิดยอดคงเหลือ\)/ })).toBeVisible();
});

test('PO: close remainder needs a reason; the closed PO cannot convert and shows why', async ({ page }) => {
  await page.goto('/'); const id = await fixtureId(page, 'poPartlyBilled');
  await page.goto(`${BASE}/${id}`);
  await page.getByRole('button', { name: 'ปิดยอดคงเหลือ' }).click();
  const dlg = page.getByRole('alertdialog', { name: 'ปิดยอดคงเหลือ' });
  await expect(dlg.getByRole('button', { name: 'ยืนยันปิดยอดคงเหลือ' })).toBeDisabled();
  await dlg.getByLabel('เหตุผล').fill('ผู้ขายส่งของไม่ครบ');
  await dlg.getByRole('button', { name: 'ยืนยันปิดยอดคงเหลือ' }).click();
  await expect(page.locator('[data-mark="closed"]')).toBeVisible();
  await expect(page.getByRole('button', { name: 'แปลงเป็น…' })).toBeDisabled();
  await expect(page.getByText(/แก้ไขเอกสาร \(ฉบับแก้ไข\) เพื่อเปิดยอดคงเหลือใหม่/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'ปิดยอดคงเหลือ' })).toHaveCount(0);
});

test('a closed PO is shown closed from the start, with its reason', async ({ page }) => {
  await page.goto('/'); const id = await fixtureId(page, 'poClosed');
  await page.goto(`${BASE}/${id}`);
  await expect(page.locator('[data-mark="closed"]')).toBeVisible();
  await expect(page.getByRole('alert').or(page.getByRole('status')).getByText(/ผู้ขายยกเลิกส่วนที่เหลือ/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'แปลงเป็น…' })).toBeDisabled();
});

test('PO: the operator may issue but not cancel; the accountant may cancel', async ({ page }) => {
  await page.goto('/?role=operator'); const id = await fixtureId(page, 'poSent');
  await page.goto(`${BASE}/${id}?role=operator`);
  await expect(page.getByRole('button', { name: 'ยกเลิกเอกสาร' })).toBeDisabled();
  await page.goto(`${BASE}/${id}?role=accountant`);
  await expect(page.getByRole('button', { name: 'ยกเลิกเอกสาร' })).toBeEnabled();
});

test('PO draft: the editor labels the due date "กำหนดรับของ", asks for a vendor, and issues once complete', async ({ page }) => {
  await page.goto('/'); const id = await fixtureId(page, 'poDraft');
  await page.goto(`${BASE}/${id}/edit`);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('ใบสั่งซื้อ');
  await expect(page.getByLabel('กำหนดรับของ')).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'ผู้ขาย' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'ยังขาดอะไร' })).toHaveText(/ครบแล้ว/);
  await page.getByRole('button', { name: 'บันทึกและออกใบสั่งซื้อ' }).click();
  await page.getByRole('alertdialog', { name: 'ออกใบสั่งซื้อ' }).getByRole('button', { name: 'ออกใบสั่งซื้อ' }).click();
  await expect(page).toHaveURL(new RegExp(`${BASE}/${id}$`));
  await expect(page.getByTestId('doc-number')).toHaveText(/PO-\d{6}-\d{4}/);
});

test('non-VAT: the PO for 2,000 kg of paddy is readable and carries no VAT', async ({ page }) => {
  await page.goto('/?company=nonvat'); const id = await fixtureId(page, 'npoIssued');
  await page.goto(`${BASE}/${id}`);
  await expect(page.getByTestId('doc-number')).toHaveText(/PO-\d{6}-\d{4}/);
  await expect(page.getByText('฿24,000.00').first()).toBeVisible(); // 2,000 x 12.00
});

test('PO prints with its own title, due label and signatures', async ({ page }) => {
  await page.goto('/'); const id = await fixtureId(page, 'poSent');
  await page.goto(`/print/PO/${id}`);
  await expect(page.locator('[data-paper-ready="true"]')).toBeVisible();
  await expect(page.locator('.paper-title h2').first()).toHaveText('ใบสั่งซื้อ');
  const sheet = page.locator('[data-paper-page]').first();
  await expect(sheet.getByText('กำหนดรับของ')).toBeVisible();
  await expect(sheet.getByText('ผู้สั่งซื้อ')).toBeVisible();
  await expect(sheet.getByText('ผู้อนุมัติ')).toBeVisible();
  await expect(page.getByText('ใบกำกับภาษี')).toHaveCount(0);
});
