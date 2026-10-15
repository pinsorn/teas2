import { expect, test } from '@playwright/test';
import { axeClean } from './helpers/axe';
import { fixtureId } from './helpers/fixtures';

test.beforeEach(async ({ page }) => { await page.goto('/'); await page.evaluate(() => localStorage.clear()); await page.reload(); });

test('list → view → paper', async ({ page }) => {
  const id = await fixtureId(page, 'tiIssuedUnpaid');
  await page.goto('/sales/tax-invoices');
  await expect(page.getByRole('row').nth(1)).toBeVisible();
  await axeClean(page);
  const number = (await page.evaluate(async (i) => (await (await fetch(`/bff/v1/docs/TI/${i}`)).json()).number, id)) as string;
  await page.getByRole('link', { name: number }).first().click(); // the fixture document, found by its number in the list
  await expect(page).toHaveURL(new RegExp(`/${id}$`));
  await expect(page.getByRole('tab', { name: 'กระดาษ' })).toBeVisible();
  await axeClean(page);
});

test('print route shows the paper with its number and total', async ({ page }) => {
  const id = await fixtureId(page, 'tiIssuedUnpaid');
  await page.goto(`/sales/tax-invoices/${id}`);
  const number = (await page.getByTestId('doc-number').textContent())!;
  const total = (await page.getByText(/^฿[\d,]+\.\d{2}$/).first().textContent())!;
  await page.goto(`/print/TI/${id}`);
  await page.waitForSelector('[data-paper-ready="true"]');
  await expect(page.locator('.paper-root')).toContainText(number);
  await expect(page.locator('.paper-root')).toContainText(total.replace('฿', ''));
  await axeClean(page);
});

test('non-fiscal edit after issue → revision 1, same number', async ({ page }) => {
  await page.goto(`/sales/tax-invoices/${await fixtureId(page, 'tiIssuedUnpaid')}`);
  const number = await page.getByTestId('doc-number').textContent();
  await page.getByRole('link', { name: 'แก้ไข' }).click();
  await expect(page.getByRole('region', { name: 'ยังขาดอะไร' })).toHaveText(/ครบแล้ว/); // totals settled, nothing mid-transition
  await axeClean(page);
  await page.getByRole('textbox', { name: 'หมายเหตุ' }).fill('อ้างอิงใบสั่งซื้อ 4471');
  await page.getByRole('button', { name: 'บันทึกการแก้ไข' }).click();
  await expect(page.getByRole('alertdialog', { name: /แผนการแก้ไข/ })).toBeVisible();
  await axeClean(page);
  await page.getByRole('button', { name: 'ยืนยันทั้งหมด' }).click();
  await expect(page.getByTestId('doc-number')).toHaveText(number!);
  await page.getByRole('tab', { name: 'ประวัติการแก้ไข' }).click();
  await expect(page.getByText(/ฉบับแก้ไขครั้งที่ 1/)).toBeVisible();
});

test('change customer on a paid TI → plan of 3 steps → replacement chain', async ({ page }) => {
  const oldId = await fixtureId(page, 'tiSettled');
  await page.goto(`/sales/tax-invoices/${oldId}`);
  await page.getByRole('link', { name: 'แก้ไข' }).click();
  await page.getByRole('combobox', { name: 'ลูกค้า' }).fill('นาวา');
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'บันทึกการแก้ไข' }).click();
  const dialog = page.getByRole('alertdialog', { name: /แผนการแก้ไข/ });
  await expect(dialog.getByRole('listitem')).toHaveCount(3);
  await axeClean(page);
  await dialog.getByRole('button', { name: 'ยืนยันทั้งหมด' }).click();
  await expect.poll(async () => page.evaluate(async (i) => (await (await fetch(`/bff/v1/docs/TI/${i}`)).json()).replacedById as string | undefined, oldId)).toBeTruthy();
  const newId = await page.evaluate(async (i) => (await (await fetch(`/bff/v1/docs/TI/${i}`)).json()).replacedById as string, oldId);
  await expect(page).toHaveURL(new RegExp(`/sales/tax-invoices/${newId}$`)); // lands on the new invoice, never on the replaced one
  await page.getByRole('tab', { name: 'เอกสารที่เกี่ยวข้อง' }).click();
  await expect(page.getByText(/ออกแทน/).first()).toBeVisible();
});

test('lower amount → plan proposes a credit note', async ({ page }) => {
  await page.goto(`/sales/tax-invoices/${await fixtureId(page, 'tiIssuedUnpaid')}`);
  await page.getByRole('link', { name: 'แก้ไข' }).click();
  await page.getByRole('textbox', { name: 'ราคาต่อหน่วย 1' }).fill('1.00');
  await page.getByRole('button', { name: 'บันทึกการแก้ไข' }).click();
  await expect(page.getByRole('alertdialog', { name: /แผนการแก้ไข/ })).toContainText('ใบลดหนี้');
});

test('operator: correction shows missing permissions and the send-to-approver path', async ({ page }) => {
  const id = await fixtureId(page, 'tiSettled');
  await page.getByRole('button', { name: 'โหมดตัวอย่าง' }).click();
  await page.getByLabel('บทบาท').selectOption('operator');
  await page.goto(`/sales/tax-invoices/${id}`);
  await page.getByRole('link', { name: 'แก้ไข' }).click();
  await page.getByRole('combobox', { name: 'ลูกค้า' }).fill('นาวา');
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'บันทึกการแก้ไข' }).click();
  const dialog = page.getByRole('alertdialog', { name: /แผนการแก้ไข/ });
  await expect(dialog.getByRole('button', { name: 'ยืนยันทั้งหมด' })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'ส่งให้ผู้มีสิทธิ์อนุมัติ' })).toBeEnabled();
  await axeClean(page);
});

test('non-VAT company: TI is not available', async ({ page }) => {
  await page.getByRole('button', { name: 'โหมดตัวอย่าง' }).click();
  await page.getByLabel('บริษัท').selectOption('nonvat');
  await page.goto('/sales/tax-invoices');
  await expect(page.getByText('ใช้ได้เฉพาะบริษัทที่จดทะเบียน VAT')).toBeVisible();
  await axeClean(page);
});

for (const state of ['empty', 'error', 'forbidden'] as const) {
  test(`screen state ${state} renders its own pattern on the list`, async ({ page }) => {
    await page.getByRole('button', { name: 'โหมดตัวอย่าง' }).click();
    await page.getByLabel('สถานะหน้าจอ').selectOption(state);
    await page.goto('/sales/tax-invoices');
    const expected = { empty: /สร้างใบกำกับภาษี/, error: /ระบบขัดข้องชั่วคราว/, forbidden: /ไม่มีสิทธิ์/ }[state];
    await expect(page.getByText(expected).first()).toBeVisible();
    await axeClean(page);
  });
}

test('screen state locked shows the lock banner with its exit on an issued TI', async ({ page }) => {
  const id = await fixtureId(page, 'tiIssuedUnpaid');
  await page.getByRole('button', { name: 'โหมดตัวอย่าง' }).click();
  await page.getByLabel('สถานะหน้าจอ').selectOption('locked');
  await page.goto(`/sales/tax-invoices/${id}`);
  const banner = page.getByRole('status', { name: 'ล็อก' });
  await expect(banner).toContainText('ภ.พ.30');
  await expect(banner.getByRole('button', { name: /ออกใบลดหนี้/ })).toBeEnabled();
  await axeClean(page);
});

test('F4: a TI in a closed period shows the period lock with the retroactive-correction exit, and edit is not blocked', async ({ page }) => {
  const id = await fixtureId(page, 'tiPeriodLocked');
  await page.goto(`/sales/tax-invoices/${id}`);
  const banner = page.getByRole('status', { name: 'ล็อก' });
  await expect(banner).toContainText('ปิดแล้ว');
  await expect(banner.getByRole('button', { name: /เปิดงวด/ })).toHaveCount(0); // the reopen exit is plain text until AC6
  await expect(page.getByRole('link', { name: 'แก้ไข', exact: true })).toHaveAttribute('href', new RegExp(`/${id}/edit$`)); // SP0 7.5: a period lock never blocks a correction
  await banner.getByRole('button', { name: /แก้ไขย้อนหลัง/ }).click();
  await expect(page).toHaveURL(new RegExp(`/${id}/edit$`));
  await axeClean(page);
});

test('reload mid-edit reopens the same draft (Review Focus 4)', async ({ page }) => {
  await page.goto('/sales/tax-invoices/new');
  await expect(page.getByRole('combobox', { name: 'ลูกค้า' })).toBeVisible();
  await axeClean(page);
  await page.getByRole('combobox', { name: 'ลูกค้า' }).fill('นาวา');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/sales\/tax-invoices\/[^/]+\/edit$/, { timeout: 5000 });
  await page.reload();
  await expect(page.getByText('0105568024684')).toBeVisible();
});

test('I2: the first autosave moves the URL to /edit without remounting the editor', async ({ page }) => {
  await page.goto('/sales/tax-invoices/new');
  const note = page.getByRole('textbox', { name: 'หมายเหตุ' });
  await note.fill('ก');
  await note.evaluate((el) => { (el as HTMLElement & { __mark?: number }).__mark = 1; });
  await expect(page).toHaveURL(/\/sales\/tax-invoices\/[^/]+\/edit$/, { timeout: 10_000 });
  await expect(note).toBeFocused();
  await expect(note).toHaveValue('ก');
  expect(await note.evaluate((el) => (el as HTMLElement & { __mark?: number }).__mark)).toBe(1); // same DOM node: no remount
});

test('I2: leaving within the idle window still saves the draft', async ({ page }) => {
  await page.goto('/sales/tax-invoices?status=draft');
  await expect(page.getByRole('row').nth(1)).toBeVisible();
  const before = await page.getByRole('row').count();
  await page.goto('/sales/tax-invoices/new');
  await page.getByRole('textbox', { name: 'หมายเหตุ' }).fill('อย่าให้หาย');
  await page.getByRole('link', { name: 'ใบกำกับภาษี' }).first().click();
  await expect(page).toHaveURL(/\/sales\/tax-invoices$/);
  await page.goto('/sales/tax-invoices?status=draft');
  await expect(page.getByRole('row')).toHaveCount(before + 1); // the new draft exists next to the seeded ones
});

test('I4: a paid TI shows its settlement lock and cancel is disabled before any dialog', async ({ page }) => {
  await page.goto(`/sales/tax-invoices/${await fixtureId(page, 'tiSettled')}`);
  await expect(page.getByRole('status', { name: 'ล็อก' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'ยกเลิกเอกสาร' })).toBeDisabled();
});
