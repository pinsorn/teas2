import { expect, test, type Page } from '@playwright/test';
import { axeClean } from './helpers/axe';
import { fixtureId } from './helpers/fixtures';
import { screenContract } from './helpers/screen-contract';

const STATES = ['empty', 'loading', 'error', 'forbidden'] as const;
const shot = async (page: Page, name: string) => { if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/${name}.png`, fullPage: true }); };

// the reconcile tab of an account belongs to one company; the operator can read the account but not reconcile it
screenContract({ name: 'reconcile tab', path: async (page) => `/finance/bank-accounts/${await fixtureId(page, 'bankKbank')}?tab=reconcile`, heading: 'กสิกรไทย กระแสรายวัน', company: 'vat', otherCompany: 'not-found', states: [...STATES], forbiddenRole: 'operator', roles: ['accountant'] });
screenContract({ name: 'reconcile tab (non-VAT)', path: async (page) => `/finance/bank-accounts/${await fixtureId(page, 'nbankKbank')}?tab=reconcile`, heading: 'กสิกรไทย กระแสรายวัน', company: 'nonvat', otherCompany: 'not-found', states: ['empty'], forbiddenRole: 'operator' });

test.beforeEach(async ({ page }) => { await page.goto('/'); await page.evaluate(() => localStorage.clear()); await page.reload(); });

const tabPath = async (page: Page, extra = '') => `/finance/bank-accounts/${await fixtureId(page, 'bankKbank')}?tab=reconcile${extra}`;
const lines = (page: Page) => page.getByRole('region', { name: 'รายการเดินบัญชี' }); // the statement table (the report below has rows of its own)
const lineRow = (page: Page, text: string | RegExp) => lines(page).getByRole('row').filter({ hasText: text });

test('an unmatched money-in line -> find a match -> pick the receipt -> matched; the receipt then carries the lock and its exit leads back to cancel the match', async ({ page }) => {
  await page.goto(await tabPath(page));
  const row = lineRow(page, '6,955.00').filter({ hasText: '5 ก.ย. 2569' });
  await expect(row).toContainText('ยังไม่จับคู่');
  await shot(page, 'reconcile-workspace');
  await row.getByRole('button', { name: 'ค้นหารายการที่ตรงกัน' }).click();
  const dialog = page.getByRole('dialog', { name: 'ค้นหารายการที่ตรงกัน' });
  await expect(dialog.getByRole('list', { name: 'เอกสารที่จับคู่ได้' }).getByRole('listitem')).toHaveCount(1);
  await shot(page, 'reconcile-match-dialog');
  await axeClean(page);
  await dialog.getByRole('checkbox', { name: 'RC-202609-0001' }).check();
  await dialog.getByRole('button', { name: 'จับคู่', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(row).toContainText('จับคู่แล้ว');
  await expect(row).toContainText('RC-202609-0001');

  // the receipt: lock banner, cancel disabled, the exit goes to the bank line
  await page.goto(`/sales/receipts/${await fixtureId(page, 'rcStatement')}`);
  const banner = page.getByRole('status', { name: /ล็อก|lock/i }).first();
  await expect(banner).toContainText('จับคู่กับรายการเดินบัญชี 5 ก.ย. 2569 6,955.00 แล้ว');
  await shot(page, 'reconcile-rc-locked');
  await expect(page.getByRole('button', { name: 'ยกเลิกเอกสาร' })).toBeDisabled();
  await axeClean(page);
  await banner.getByRole('button', { name: 'ยกเลิกการจับคู่' }).click();
  await expect(page).toHaveURL(/\/finance\/bank-accounts\/ba-kbank\?line=bi-001-003/);
  await expect(lines(page).getByRole('row')).toHaveCount(2); // header + the one line
  await shot(page, 'reconcile-line-focus');
  await lines(page).getByRole('row').nth(1).getByRole('button', { name: 'ยกเลิกการจับคู่' }).click();
  const confirm = page.getByRole('alertdialog');
  await confirm.getByRole('button', { name: 'ยกเลิกการจับคู่' }).click();
  await expect(lines(page).getByRole('row').nth(1)).toContainText('ยังไม่จับคู่');

  // unmatching removed the lock: the receipt can be cancelled again
  await page.goto(`/sales/receipts/${await fixtureId(page, 'rcStatement')}`);
  await expect(page.getByRole('button', { name: 'ยกเลิกเอกสาร' })).toBeEnabled();
  await expect(page.getByText('จับคู่กับรายการเดินบัญชี')).toHaveCount(0);
});

test('an inline journal: the fee line is booked to an expense account and is final; tax control accounts are not offered; the report still ties out', async ({ page }) => {
  await page.goto(await tabPath(page));
  const report = page.locator('[data-report-region]');
  await expect(report.getByText('ยอดกระทบตรงกัน', { exact: false })).toBeVisible();
  const row = lineRow(page, 'ค่าธรรมเนียมธนาคาร');
  await row.getByRole('button', { name: 'บันทึกบัญชี' }).click();
  const dialog = page.getByRole('dialog', { name: 'บันทึกบัญชีจากรายการเดินบัญชี' });
  const account = dialog.getByRole('combobox', { name: 'บัญชีที่จ่าย (เดบิต)' });
  await expect(account.locator('option[value="5200"]')).toHaveCount(1);
  for (const hidden of ['2151', '1170', '1180', '2131', '2152']) await expect(account.locator(`option[value="${hidden}"]`)).toHaveCount(0);
  await shot(page, 'reconcile-inline-dialog');
  await axeClean(page);
  await account.selectOption('5200');
  await dialog.getByRole('button', { name: 'บันทึกบัญชี' }).click();
  await expect(dialog).toBeHidden();
  await expect(row).toContainText('ลงบัญชีแล้ว');
  await expect(row.getByRole('button')).toHaveCount(0); // posted: immutable
  await expect(row).toContainText('แก้ไขไม่ได้');
  await expect(report.getByText('ยอดกระทบตรงกัน', { exact: false })).toBeVisible();
  await expect(report.getByRole('table').getByRole('row', { name: /ยอดตามบัญชีปรับปรุงแล้ว/ })).toBeVisible();
});

test('a transfer to another own account books one journal, matches the line, and the report still ties out', async ({ page }) => {
  await page.goto(await tabPath(page));
  const report = page.locator('[data-report-region]');
  const row = lineRow(page, /^2 ก\.ย\. 2569/); // the 35,000 rent payment
  await row.getByRole('button', { name: 'โอนระหว่างบัญชี' }).click();
  const dialog = page.getByRole('dialog', { name: 'โอนระหว่างบัญชีของบริษัท' });
  const other = dialog.getByRole('combobox', { name: 'บัญชีอีกฝั่ง' });
  await expect(other.locator('option[value="ba-scb"]')).toHaveCount(1);
  await expect(other.locator('option[value="ba-kbank"]')).toHaveCount(0);
  await shot(page, 'reconcile-transfer-dialog');
  await other.selectOption('ba-scb');
  await dialog.getByRole('button', { name: 'โอน', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(row).toContainText('จับคู่แล้ว');
  await expect(row).toContainText('โอนระหว่างบัญชี');
  await expect(report.getByText('ยอดกระทบตรงกัน', { exact: false })).toBeVisible();
  // the exit of a mis-targeted transfer: unmatch, reverse (a reason is required), then the line is free again
  await row.getByRole('button', { name: 'ยกเลิกการจับคู่' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'ยกเลิกการจับคู่' }).click();
  await expect(row).toContainText('ยังไม่จับคู่');
  await row.getByRole('button', { name: 'ย้อนการโอน' }).click();
  const why = page.getByRole('alertdialog');
  await expect(why.getByRole('button', { name: 'ย้อนการโอน' })).toBeDisabled();
  await why.getByRole('textbox', { name: /เหตุผล/ }).fill('โอนผิดบัญชี');
  await why.getByRole('button', { name: 'ย้อนการโอน' }).click();
  await expect(row.getByRole('button', { name: 'ย้อนการโอน' })).toHaveCount(0);
  await expect(row.getByRole('button', { name: 'โอนระหว่างบัญชี' })).toBeVisible();
});

test('lock to a date: refused while lines are open; then locked lines need a reason to unmatch', async ({ page }) => {
  await page.goto(await tabPath(page));
  await page.getByRole('textbox', { name: 'ปิดการกระทบยอดถึงวันที่' }).fill('2026-09-05');
  await page.getByRole('button', { name: 'ปิดการกระทบยอด', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'ยังมีรายการเดินบัญชีที่ยังไม่ได้จับคู่ 3 รายการ' })).toBeVisible();
  // resolve the three: skip the two payments, match the receipt
  for (const date of [/^2 ก\.ย\. 2569/, /^4 ก\.ย\. 2569/]) await lineRow(page, date).getByRole('button', { name: 'ข้าม' }).click(); // the 2 Sep and 4 Sep payments
  const receipt = lineRow(page, '6,955.00').filter({ hasText: '5 ก.ย. 2569' });
  await receipt.getByRole('button', { name: 'ค้นหารายการที่ตรงกัน' }).click();
  const dialog = page.getByRole('dialog', { name: 'ค้นหารายการที่ตรงกัน' });
  await dialog.getByRole('checkbox', { name: 'RC-202609-0001' }).check();
  await dialog.getByRole('button', { name: 'จับคู่', exact: true }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole('textbox', { name: 'ปิดการกระทบยอดถึงวันที่' }).fill('2026-09-05');
  await page.getByRole('button', { name: 'ปิดการกระทบยอด', exact: true }).click();
  await expect(page.getByText('ปิดการกระทบยอดถึง 5 ก.ย. 2569')).toBeVisible();
  await expect(receipt).toContainText('ล็อก');
  await shot(page, 'reconcile-locked');
  // a locked match: the reason is required
  await receipt.getByRole('button', { name: 'ยกเลิกการจับคู่' }).click();
  const ask = page.getByRole('alertdialog');
  const confirm = ask.getByRole('button', { name: 'ยกเลิกการจับคู่' });
  await expect(confirm).toBeDisabled();
  await ask.getByLabel(/เหตุผล/).fill('จับคู่ผิดใบ');
  await confirm.click();
  await expect(receipt).toContainText('ยังไม่จับคู่');
});

test('mobile 390x844: the workspace, the match dialog and the report fit without a horizontal page scroll and pass axe', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(await tabPath(page));
  await expect(page.getByRole('tab', { name: 'กระทบยอด' })).toHaveAttribute('aria-selected', 'true');
  await expect(lineRow(page, '6,955.00')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await shot(page, 'reconcile-mobile');
  await axeClean(page);
  await lineRow(page, '6,955.00').getByRole('button', { name: 'ค้นหารายการที่ตรงกัน' }).click();
  const dialog = page.getByRole('dialog', { name: 'ค้นหารายการที่ตรงกัน' });
  await expect(dialog.getByRole('checkbox', { name: 'RC-202609-0001' })).toBeVisible();
  await shot(page, 'reconcile-mobile-dialog');
  await axeClean(page);
});

test('an operator opening the exit URL of a lock sees the forbidden tab, not the line actions', async ({ page }) => {
  await page.goto(`${await tabPath(page, '&line=bi-001-003')}&role=operator`);
  await expect(page.locator('[data-screen-state="forbidden"]').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'ค้นหารายการที่ตรงกัน' })).toHaveCount(0);
});
