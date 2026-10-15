import { expect, test } from '@playwright/test';
import { axeClean } from './helpers/axe';
import { screenContract } from './helpers/screen-contract';

for (const [name, path, heading] of [['customers', '/master/customers', 'ลูกค้า'], ['vendors', '/master/vendors', 'ผู้ขาย']] as const) {
  screenContract({ name, path, heading, company: 'both', states: ['empty', 'loading', 'error', 'forbidden'], roles: ['operator', 'accountant', 'admin'] });
}
// pc-01 exists only in the VAT company, so the detail page is not a screenContract (its out-of-scope check is a "not found", not a "not available")
for (const role of ['accountant', 'admin'] as const) {
  test(`customer detail renders its heading as ${role}`, async ({ page }) => {
    await page.goto(`/master/customers/pc-01?role=${role}`);
    await expect(page.getByRole('heading', { level: 1, name: 'บริษัท นาวาพาณิชย์ จำกัด' })).toBeVisible();
    await axeClean(page);
  });
}
for (const state of ['loading', 'error', 'forbidden'] as const) {
  test(`customer detail state ${state}`, async ({ page }) => {
    await page.goto(`/master/customers/pc-01?state=${state}`);
    await expect(page.locator(`[data-screen-state="${state}"]`).first()).toBeVisible();
  });
}
test('a customer of the other company is "not found", not an error', async ({ page }) => {
  await page.goto('/master/customers/pc-01?company=nonvat');
  await expect(page.locator('[data-screen-state="not-found"]')).toBeVisible();
});

// 010550000000 + check digit 3 (tinCheckDigit): the first 12 digits are fictional, 0105500000001 is wrong on purpose
const BAD_TIN = '0105500000001', GOOD_TIN = '0105500000003';

test('create a customer with a bad TIN shows the checksum error; fix it and save', async ({ page }) => {
  await page.goto('/master/customers');
  await page.getByRole('button', { name: 'เพิ่มลูกค้า' }).click();
  const dialog = page.getByRole('dialog', { name: 'เพิ่มลูกค้า' });
  await dialog.getByLabel('ประเภท').selectOption('juristic');
  await dialog.getByLabel('รหัส').fill('C99');
  await dialog.getByLabel('ชื่อ', { exact: true }).fill('บริษัท ทดสอบระบบ จำกัด');
  await dialog.getByLabel('เลขประจำตัวผู้เสียภาษี').fill(BAD_TIN);
  await dialog.getByRole('button', { name: 'บันทึก' }).click();
  await expect(dialog.getByText('เลขประจำตัวผู้เสียภาษีไม่ถูกต้อง')).toBeVisible();
  await dialog.getByLabel('เลขประจำตัวผู้เสียภาษี').fill(GOOD_TIN);
  await dialog.getByRole('button', { name: 'บันทึก' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('link', { name: 'C99' })).toBeVisible();
});

test('the server rejects a duplicate code on the field itself', async ({ page }) => {
  await page.goto('/master/customers');
  await page.getByRole('button', { name: 'เพิ่มลูกค้า' }).click();
  const dialog = page.getByRole('dialog', { name: 'เพิ่มลูกค้า' });
  await dialog.getByLabel('ประเภท').selectOption('individual');
  await dialog.getByLabel('รหัส').fill('C01'); // pc-01 already has it
  await dialog.getByLabel('ชื่อ', { exact: true }).fill('คุณทดสอบ ซ้ำรหัส');
  await dialog.getByRole('button', { name: 'บันทึก' }).click();
  await expect(dialog.getByText('รหัสนี้ใช้แล้ว')).toBeVisible();
  await expect(dialog.getByLabel('รหัส')).toBeFocused();
});

test('customer detail shows documents and open items from the server', async ({ page }) => {
  await page.goto('/master/customers/pc-01');
  await page.getByRole('tab', { name: 'เอกสาร' }).click();
  await expect(page.getByRole('row', { name: /TI-\d{6}-\d{4}/ }).first()).toBeVisible();
  await page.getByRole('tab', { name: 'ยอดค้าง' }).click();
  await expect(page.getByRole('row', { name: /TI-\d{6}-\d{4}/ }).first()).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'ยอดค้างรวม' })).toContainText(/฿[\d,]+\.\d{2}/);
});

test('a used party can be deactivated and moves behind the "ปิดใช้งาน" filter; the foreign vendor shows the VAT-D field', async ({ page }) => {
  await page.goto('/master/customers/pc-01');
  await page.getByRole('button', { name: 'ปิดใช้งาน' }).click();
  const confirm = page.getByRole('alertdialog');
  await expect(confirm).toContainText('เอกสารเดิมไม่เปลี่ยน');
  await confirm.getByRole('button', { name: 'ปิดใช้งาน' }).click();
  await expect(page.getByRole('button', { name: 'เปิดใช้งาน' })).toBeVisible();
  await page.goto('/master/customers?active=false');
  await expect(page.getByRole('link', { name: 'C01' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'C13' })).toBeVisible();
  await page.goto('/master/vendors/pv-12');
  await page.getByRole('button', { name: 'แก้ไข' }).click();
  await expect(page.getByRole('dialog', { name: 'แก้ไขผู้ขาย' }).getByLabel('จดทะเบียน VAT-D (ภ.พ.36 ไม่ต้องนำส่ง)')).toBeVisible();
});
