import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => { await page.goto('/'); await page.evaluate(() => localStorage.clear()); await page.reload(); });

const axeClean = async (page: import('@playwright/test').Page) => {
  const r = await new AxeBuilder({ page }).analyze();
  expect(r.violations.filter((v) => ['serious', 'critical'].includes(v.impact ?? ''))).toEqual([]);
};

test('list → view → paper', async ({ page }) => {
  await page.goto('/sales/tax-invoices');
  await axeClean(page);
  await page.getByRole('row').nth(1).getByRole('link').first().click();
  await expect(page.getByRole('tab', { name: 'กระดาษ' })).toBeVisible();
  await axeClean(page);
});

test('non-fiscal edit after issue → revision 1, same number', async ({ page }) => {
  await page.goto('/sales/tax-invoices?status=issued');
  await page.getByRole('row').nth(1).getByRole('link').first().click();
  const number = await page.getByTestId('doc-number').textContent();
  await page.getByRole('link', { name: 'แก้ไข' }).click();
  await page.getByRole('textbox', { name: 'หมายเหตุ' }).fill('อ้างอิงใบสั่งซื้อ 4471');
  await page.getByRole('button', { name: 'บันทึกการแก้ไข' }).click();
  await page.getByRole('button', { name: 'ยืนยันทั้งหมด' }).click();
  await expect(page.getByTestId('doc-number')).toHaveText(number!);
  await page.getByRole('tab', { name: 'ประวัติการแก้ไข' }).click();
  await expect(page.getByText(/ฉบับแก้ไขครั้งที่ 1/)).toBeVisible();
});

test('change customer on a paid TI → plan of 3 steps → replacement chain', async ({ page }) => {
  await page.goto('/sales/tax-invoices?status=settled');
  await page.getByRole('row').nth(2).getByRole('link').first().click();
  await page.getByRole('link', { name: 'แก้ไข' }).click();
  await page.getByRole('combobox', { name: 'ลูกค้า' }).fill('นาวา');
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'บันทึกการแก้ไข' }).click();
  const dialog = page.getByRole('alertdialog', { name: /แผนการแก้ไข/ });
  await expect(dialog.getByRole('listitem')).toHaveCount(3);
  await dialog.getByRole('button', { name: 'ยืนยันทั้งหมด' }).click();
  await page.getByRole('tab', { name: 'เอกสารที่เกี่ยวข้อง' }).click();
  await expect(page.getByText(/ออกแทนโดย/).first()).toBeVisible();
});

test('lower amount → plan proposes a credit note', async ({ page }) => {
  await page.goto('/sales/tax-invoices?status=issued');
  await page.getByRole('row').nth(1).getByRole('link').first().click();
  await page.getByRole('link', { name: 'แก้ไข' }).click();
  await page.getByRole('textbox', { name: 'ราคาต่อหน่วย 1' }).fill('1.00');
  await page.getByRole('button', { name: 'บันทึกการแก้ไข' }).click();
  await expect(page.getByRole('alertdialog', { name: /แผนการแก้ไข/ })).toContainText('ใบลดหนี้');
});

test('operator: correction shows missing permissions and the send-to-approver path', async ({ page }) => {
  await page.getByRole('button', { name: 'โหมดตัวอย่าง' }).click();
  await page.getByLabel('บทบาท').selectOption('operator');
  await page.goto('/sales/tax-invoices?status=settled');
  await page.getByRole('row').nth(1).getByRole('link').first().click();
  await page.getByRole('link', { name: 'แก้ไข' }).click();
  await page.getByRole('combobox', { name: 'ลูกค้า' }).fill('นาวา');
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'บันทึกการแก้ไข' }).click();
  const dialog = page.getByRole('alertdialog', { name: /แผนการแก้ไข/ });
  await expect(dialog.getByRole('button', { name: 'ยืนยันทั้งหมด' })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'ส่งให้ผู้มีสิทธิ์อนุมัติ' })).toBeEnabled();
});

test('non-VAT company: TI is not available', async ({ page }) => {
  await page.getByRole('button', { name: 'โหมดตัวอย่าง' }).click();
  await page.getByLabel('บริษัท').selectOption('nonvat');
  await page.goto('/sales/tax-invoices');
  await expect(page.getByText('ใช้ได้เฉพาะบริษัทที่จดทะเบียน VAT')).toBeVisible();
});

for (const state of ['empty', 'error', 'forbidden'] as const) {
  test(`screen state ${state} renders its own pattern on the list`, async ({ page }) => {
    await page.getByRole('button', { name: 'โหมดตัวอย่าง' }).click();
    await page.getByLabel('สถานะหน้าจอ').selectOption(state);
    await page.goto('/sales/tax-invoices');
    const expected = { empty: /สร้างใบกำกับภาษี/, error: /ระบบขัดข้องชั่วคราว/, forbidden: /ไม่มีสิทธิ์/ }[state];
    await expect(page.getByText(expected).first()).toBeVisible();
  });
}

test('screen state locked shows the lock banner with its exit on an issued TI', async ({ page }) => {
  await page.getByRole('button', { name: 'โหมดตัวอย่าง' }).click();
  await page.getByLabel('สถานะหน้าจอ').selectOption('locked');
  await page.goto('/sales/tax-invoices?status=issued');
  await page.getByRole('row').nth(1).getByRole('link').first().click();
  await expect(page.getByRole('status', { name: 'ล็อก' })).toContainText('ภ.พ.30');
});

test('reload mid-edit reopens the same draft (Review Focus 4)', async ({ page }) => {
  await page.goto('/sales/tax-invoices/new');
  await page.getByRole('combobox', { name: 'ลูกค้า' }).fill('นาวา');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/sales\/tax-invoices\/[^/]+\/edit$/, { timeout: 5000 });
  await page.reload();
  await expect(page.getByText('0105568024684')).toBeVisible();
});
