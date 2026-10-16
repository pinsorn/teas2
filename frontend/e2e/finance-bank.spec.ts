import { expect, test, type Page } from '@playwright/test';
import { KBIZ_2026_10, KBIZ_OCT_NAME } from '../src/mocks/fixtures/statements/kbiz-2026-10.csv';
import { axeClean } from './helpers/axe';
import { fixtureId } from './helpers/fixtures';
import { screenContract } from './helpers/screen-contract';

const STATES = ['empty', 'loading', 'error', 'forbidden'] as const;
const ROLES = ['operator', 'accountant', 'admin'] as const;
const shot = async (page: Page, name: string) => { if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/${name}.png`, fullPage: true }); };

screenContract({ name: 'bank accounts list', path: '/finance/bank-accounts', heading: 'บัญชีธนาคารและเงินสด', company: 'both', states: [...STATES], roles: [...ROLES] });
// the account detail belongs to one company: the other one answers "not found", not "not available"
screenContract({ name: 'bank account detail', path: async (page) => `/finance/bank-accounts/${await fixtureId(page, 'bankKbank')}`, heading: 'กสิกรไทย กระแสรายวัน', company: 'vat', otherCompany: 'not-found', states: [...STATES], roles: [...ROLES] });
screenContract({ name: 'bank account detail (non-VAT)', path: async (page) => `/finance/bank-accounts/${await fixtureId(page, 'nbankKbank')}`, heading: 'กสิกรไทย กระแสรายวัน', company: 'nonvat', otherCompany: 'not-found', states: ['empty'], roles: ['operator'] });

test.beforeEach(async ({ page }) => { await page.goto('/'); await page.evaluate(() => localStorage.clear()); await page.reload(); });

const csvFile = (content = KBIZ_2026_10, name = KBIZ_OCT_NAME) => ({ name, mimeType: 'text/csv', buffer: Buffer.from(content, 'utf8') });
const bankPath = async (page: Page, key: 'bankKbank' | 'bankEmpty') => `/finance/bank-accounts/${await fixtureId(page, key)}`;

test('an account with no imports says so and offers the import', async ({ page }) => {
  await page.goto(await bankPath(page, 'bankEmpty'));
  await expect(page.getByRole('heading', { level: 1, name: 'ไทยพาณิชย์ ออมทรัพย์' })).toBeVisible();
  await expect(page.getByText('ยังไม่มีรายการเดินบัญชี — นำเข้า statement')).toBeVisible();
  await shot(page, 'bank-empty');
  await expect(page.locator('[data-screen-state="empty"]').getByRole('button', { name: 'นำเข้า statement' })).toBeVisible();
});

test('upload the October CSV: 12 lines come in, the lines table shows them, nothing is posted', async ({ page }) => {
  await page.goto(await bankPath(page, 'bankKbank'));
  await expect(page.getByRole('row')).toHaveCount(1 + 18); // header + the seeded September lines
  await page.getByRole('button', { name: 'นำเข้า statement' }).click();
  const dialog = page.getByRole('dialog', { name: 'นำเข้า statement' });
  await shot(page, 'bank-import-dialog');
  await axeClean(page);
  await dialog.getByLabel(/ไฟล์ statement/).setInputFiles(csvFile());
  await dialog.getByRole('button', { name: 'นำเข้า', exact: true }).click();
  await expect(dialog.getByText('นำเข้าสำเร็จ 12 รายการ')).toBeVisible();
  await shot(page, 'bank-import-done');
  await dialog.getByRole('button', { name: 'ปิด' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('row')).toHaveCount(1 + 30);
  await expect(page.getByRole('row', { name: /ค่าธรรมเนียมธนาคาร/ }).first()).toContainText('25.00');
  await expect(page.getByRole('cell', { name: 'โอนเงิน ค่าเช่าสำนักงาน' })).toHaveCount(2); // 2 Sep and 1 Oct
  await shot(page, 'bank-lines');
});

test('a statement of another account is refused with the reason, and nothing is imported', async ({ page }) => {
  await page.goto(await bankPath(page, 'bankEmpty'));
  await page.getByRole('button', { name: 'นำเข้า statement' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'นำเข้า statement' });
  await dialog.getByLabel(/ไฟล์ statement/).setInputFiles(csvFile());
  await dialog.getByRole('button', { name: 'นำเข้า', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('เลขที่บัญชีในไฟล์ไม่ตรงกับบัญชี');
  await dialog.getByRole('button', { name: 'ปิด' }).first().click();
  await expect(page.getByText('ยังไม่มีรายการเดินบัญชี — นำเข้า statement')).toBeVisible();
});

test('a PDF other than the sample is unreadable (the CSV hint), and the password field never keeps what was typed', async ({ page }) => {
  await page.goto(await bankPath(page, 'bankKbank'));
  await page.getByRole('button', { name: 'นำเข้า statement' }).click();
  const dialog = page.getByRole('dialog', { name: 'นำเข้า statement' });
  await dialog.getByLabel(/ไฟล์ statement/).setInputFiles({ name: 'other.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 other') });
  await dialog.getByLabel(/รหัสผ่านไฟล์ PDF/).fill('S3cr3t-pw-9');
  await dialog.getByRole('button', { name: 'นำเข้า', exact: true }).click();
  await expect(dialog.getByRole('alert')).toHaveText('อ่านไฟล์ PDF ไม่ได้ — ลองไฟล์ CSV จาก K BIZ');
  await expect(dialog.getByLabel(/รหัสผ่านไฟล์ PDF/)).toHaveValue('');
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain('S3cr3t-pw-9');
});

test('the sample K PLUS PDF imports behind the seeded September file: 18 lines and an overlap warning, not an error', async ({ page }) => {
  await page.goto(await bankPath(page, 'bankKbank'));
  await page.getByRole('button', { name: 'นำเข้า statement' }).click();
  const dialog = page.getByRole('dialog', { name: 'นำเข้า statement' });
  await dialog.getByLabel(/ไฟล์ statement/).setInputFiles({ name: 'KPLUS_Statement_Sep2026.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 sample') });
  await dialog.getByRole('button', { name: 'นำเข้า', exact: true }).click();
  await expect(dialog.getByText('นำเข้าสำเร็จ 18 รายการ')).toBeVisible();
  await expect(dialog.getByText(/ทับซ้อนกับไฟล์ที่นำเข้าแล้ว/)).toBeVisible();
});

test('the same CSV again is refused as already imported, naming the earlier file (M3)', async ({ page }) => {
  await page.goto(await bankPath(page, 'bankKbank'));
  for (const round of [1, 2]) {
    await page.getByRole('button', { name: 'นำเข้า statement' }).click();
    const dialog = page.getByRole('dialog', { name: 'นำเข้า statement' });
    await dialog.getByLabel(/ไฟล์ statement/).setInputFiles(csvFile());
    await dialog.getByRole('button', { name: 'นำเข้า', exact: true }).click();
    if (round === 1) { await expect(dialog.getByText('นำเข้าสำเร็จ 12 รายการ')).toBeVisible(); await dialog.getByRole('button', { name: 'ปิด' }).click(); }
    else await expect(dialog.getByRole('alert')).toContainText(`ไฟล์นี้นำเข้าแล้ว: ${KBIZ_OCT_NAME}`);
  }
});

test('an operator reads the account but can neither edit nor import', async ({ page }) => {
  await page.goto(`${await bankPath(page, 'bankKbank')}?role=operator`);
  await expect(page.getByRole('heading', { level: 1, name: 'กสิกรไทย กระแสรายวัน' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'แก้ไข' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'นำเข้า statement' })).toBeDisabled();
  await expect(page.getByRole('row')).toHaveCount(1 + 18);
});

test('the GL account is read-only once used, free before; a cash box has no statement', async ({ page }) => {
  await page.goto(await bankPath(page, 'bankKbank'));
  await page.getByRole('button', { name: 'แก้ไข' }).click();
  const dialog = page.getByRole('dialog', { name: 'แก้ไขบัญชีธนาคารและเงินสด' });
  await expect(dialog.getByLabel('บัญชีแยกประเภท')).toHaveAttribute('readonly', '');
  await expect(dialog.getByText('แก้ไม่ได้หลังจากใช้ในเอกสารแล้ว')).toBeVisible();
  await dialog.getByRole('button', { name: 'ยกเลิก' }).click();
  await page.goto(`${await bankPath(page, 'bankEmpty')}`);
  await page.getByRole('button', { name: 'แก้ไข' }).click();
  const free = page.getByRole('dialog', { name: 'แก้ไขบัญชีธนาคารและเงินสด' }).getByLabel('บัญชีแยกประเภท');
  await expect(free).toBeEditable();
  await page.goto('/finance/bank-accounts');
  await page.getByRole('link', { name: 'เงินสดย่อย' }).click();
  await expect(page.getByText('บัญชีเงินสดไม่มีรายการเดินบัญชี')).toBeVisible();
  await expect(page.getByRole('button', { name: 'นำเข้า statement' })).toHaveCount(0);
});

test('one source: a new account shows in the receipt editor; a closed one is not offered there', async ({ page }) => {
  await page.goto('/finance/bank-accounts');
  await page.getByRole('button', { name: 'เพิ่มบัญชีธนาคารและเงินสด' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'เพิ่มบัญชีธนาคารและเงินสด' });
  await dialog.getByLabel('ธนาคาร').selectOption('bbl');
  await dialog.getByLabel('เลขที่บัญชี').fill('999-9-99999-9');
  await dialog.getByLabel('ชื่อบัญชี').fill('กรุงเทพ ออมทรัพย์');
  await dialog.getByLabel('บัญชีแยกประเภท').selectOption('1123');
  await shot(page, 'bank-form');
  await dialog.getByRole('button', { name: 'บันทึก' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('row', { name: /กรุงเทพ ออมทรัพย์/ })).toContainText('1123');
  await page.goto('/sales/receipts/new');
  const picker = page.getByRole('combobox', { name: 'บัญชีรับ/จ่ายเงิน' });
  await expect(picker.getByRole('option', { name: /กรุงเทพ ออมทรัพย์ 999-9-99999-9/ })).toHaveCount(1);
  // close ba-scb: gone from the picker of a new document
  await page.goto(await bankPath(page, 'bankEmpty'));
  await page.getByRole('button', { name: 'ปิดใช้งาน' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'ปิดใช้งาน' }).click();
  await expect(page.getByText('ปิดใช้งาน', { exact: true }).first()).toBeVisible();
  await page.goto('/sales/receipts/new');
  await expect(page.getByRole('combobox', { name: 'บัญชีรับ/จ่ายเงิน' }).getByRole('option', { name: /ไทยพาณิชย์/ })).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: 'บัญชีรับ/จ่ายเงิน' }).getByRole('option', { name: /กสิกรไทย/ })).toHaveCount(1);
});

test.describe('mobile', () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test('the detail page and the import dialog fit a phone', async ({ page }) => {
    await page.goto(await bankPath(page, 'bankKbank'));
    await expect(page.getByRole('heading', { level: 1, name: 'กสิกรไทย กระแสรายวัน' })).toBeVisible();
    await shot(page, 'bank-detail-mobile');
    await axeClean(page);
    await page.getByRole('button', { name: 'นำเข้า statement' }).click();
    const dialog = page.getByRole('dialog', { name: 'นำเข้า statement' });
    await dialog.getByLabel(/ไฟล์ statement/).setInputFiles(csvFile());
    await dialog.getByRole('button', { name: 'นำเข้า', exact: true }).click();
    await expect(dialog.getByText('นำเข้าสำเร็จ 12 รายการ')).toBeVisible();
    await shot(page, 'bank-import-done-mobile');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
});
