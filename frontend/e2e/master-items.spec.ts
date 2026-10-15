import { expect, test } from '@playwright/test';
import { axeClean } from './helpers/axe';
import { screenContract } from './helpers/screen-contract';

screenContract({ name: 'items', path: '/master/items', heading: 'สินค้า/บริการ', company: 'both', states: ['empty', 'loading', 'error', 'forbidden'], roles: ['operator', 'accountant'] });

test.beforeEach(async ({ page }) => { await page.goto('/'); await page.evaluate(() => localStorage.clear()); await page.reload(); });

test('edit an item from its row: the dialog opens, the change is saved and shows in the list', async ({ page }) => {
  await page.goto('/master/items');
  await page.getByRole('button', { name: 'SV-01', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'แก้ไขสินค้า/บริการ' });
  await expect(dialog.getByLabel('ชื่อ', { exact: true })).toHaveValue('ออกแบบอัตลักษณ์องค์กร');
  await axeClean(page);
  await dialog.getByLabel('ใช้ในเอกสารซื้อ').check();
  await dialog.getByLabel('หมวดค่าใช้จ่าย').selectOption('services');
  await dialog.getByRole('button', { name: 'บันทึก' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('row', { name: /SV-01/ })).toContainText('ขายและซื้อ');
});

test('add a purchase item: it shows as "ซื้อ" and the non-VAT company has no VAT field', async ({ page }) => {
  await page.goto('/master/items?company=nonvat');
  await page.getByRole('button', { name: 'เพิ่มสินค้า/บริการ' }).click();
  const dialog = page.getByRole('dialog', { name: 'เพิ่มสินค้า/บริการ' });
  await expect(dialog.getByLabel('ภาษีมูลค่าเพิ่ม')).toHaveCount(0);
  await dialog.getByLabel('ประเภท').selectOption('good');
  await dialog.getByLabel('รหัส').fill('NV-77');
  await dialog.getByLabel('ชื่อ', { exact: true }).fill('ถุงพลาสติก');
  await dialog.getByLabel('หน่วย', { exact: true }).fill('แพ็ค');
  await dialog.getByLabel('ใช้ในเอกสารขาย').uncheck();
  await dialog.getByLabel('ใช้ในเอกสารซื้อ').check();
  await dialog.getByRole('button', { name: 'บันทึก' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('row', { name: /NV-77/ })).toContainText('ซื้อ');
});

test('an operator can read items but not add them', async ({ page }) => {
  await page.goto('/master/items?role=operator');
  await expect(page.getByRole('button', { name: 'เพิ่มสินค้า/บริการ' })).toBeDisabled();
});

test('quick-create: type an unknown customer in the invoice editor, add it, and the editor carries on', async ({ page }) => {
  await page.goto('/sales/tax-invoices/new');
  const name = 'บริษัท ลูกค้าใหม่ จำกัด';
  await page.getByRole('combobox', { name: 'ลูกค้า' }).fill(name);
  await page.getByRole('option', { name: `+ เพิ่มลูกค้า “${name}”` }).click();
  const dialog = page.getByRole('dialog', { name: 'เพิ่มลูกค้า' });
  await expect(dialog.getByLabel('ชื่อ', { exact: true })).toHaveValue(name);
  await expect(dialog.getByLabel('รหัส')).toHaveValue('C14');
  await dialog.getByLabel('เลขประจำตัวผู้เสียภาษี').fill('0105500000003');
  await dialog.getByLabel('สาขา').fill('00000');
  await dialog.getByLabel('ที่อยู่ตามทะเบียน').fill('88 ถนนพระราม 4 กรุงเทพมหานคร');
  await axeClean(page);
  await dialog.getByRole('button', { name: 'บันทึก' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('combobox', { name: 'ลูกค้า' })).toHaveValue(name);
  await expect(page.getByText(/0105500000003/)).toBeVisible();
  await expect(page.getByRole('region', { name: 'ยังขาดอะไร' })).not.toContainText('เลือกลูกค้า');
  // the new customer is a normal master record from now on
  await page.goto('/master/customers');
  await expect(page.getByRole('link', { name: 'C14' })).toBeVisible();
});
