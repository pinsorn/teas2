import { expect, test, type Page } from '@playwright/test';
import { axeClean } from './helpers/axe';
import { screenContract } from './helpers/screen-contract';

const BASE = '/accounting/chart-of-accounts';
const shot = async (page: Page, name: string) => { if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/${name}.png`, fullPage: true }); };

// The chart is read with ledger.read (accountant); the operator is forbidden
screenContract({ name: 'chart of accounts', path: BASE, heading: 'ผังบัญชี', company: 'both', states: ['empty', 'loading', 'error', 'forbidden'], forbiddenRole: 'operator' });

test.beforeEach(async ({ page }) => { await page.goto('/'); await page.evaluate(() => localStorage.clear()); await page.reload(); });

const row = (page: Page, code: string) => page.getByRole('row', { name: new RegExp(`(^| )${code} `) });
const api = <T,>(page: Page, path: string) => page.evaluate(async (p) => (await fetch(`/bff/v1${p}`)).json(), path) as Promise<T>;

test('the chart is a tree: headers bold, sub-accounts indented, collapse and search keep their promises', async ({ page }) => {
  await page.goto(BASE);
  await expect(page.getByRole('heading', { level: 1, name: 'ผังบัญชี' })).toBeVisible();
  await expect(row(page, '1130')).toBeVisible();
  const indent = (code: string) => row(page, code).locator('td').first().locator('span').first().evaluate((el) => parseFloat(getComputedStyle(el).paddingInlineStart));
  expect(await indent('1000')).toBe(0);
  expect(await indent('1100')).toBeGreaterThan(0);
  expect(await indent('1130')).toBeGreaterThan(await indent('1100'));
  await page.getByRole('button', { name: 'ย่อ 1100' }).click();
  await expect(row(page, '1130')).toHaveCount(0);
  await page.getByRole('button', { name: 'ขยาย 1100' }).click();
  await expect(row(page, '1130')).toBeVisible();
  await page.getByRole('searchbox', { name: 'ค้นหา' }).fill('2151');
  await expect(row(page, '2151')).toBeVisible();
  await expect(row(page, '2100')).toBeVisible(); // its header stays
  await expect(row(page, '2000')).toBeVisible();
  await expect(row(page, '1130')).toHaveCount(0);
  await shot(page, 'coa-search');
});

test('add 5190 "ค่าใช้จ่ายเบ็ดเตล็ด" under 5000, then try to deactivate 1130: the refusal names the posting rule', async ({ page }) => {
  await page.goto(BASE);
  await expect(row(page, '5000')).toBeVisible();
  await shot(page, 'coa-tree');
  await page.getByRole('button', { name: 'เพิ่มผังบัญชี' }).first().click();
  const dlg = page.getByRole('dialog', { name: 'เพิ่มผังบัญชี' });
  await dlg.getByLabel('รหัส').fill('5190');
  await dlg.getByLabel('ชื่อบัญชี (ไทย)').fill('ค่าใช้จ่ายเบ็ดเตล็ด');
  await expect(dlg.getByRole('option', { name: '5000 · ค่าใช้จ่าย' })).toBeAttached();
  await dlg.getByLabel('บัญชีหมวดที่อยู่ภายใต้').selectOption('5000');
  await dlg.getByLabel('หมวดบัญชี').selectOption('selling-admin-expense');
  await dlg.getByLabel('ประเภทย่อย').selectOption('expense');
  await shot(page, 'coa-add-dialog');
  await axeClean(page);
  await dlg.getByRole('button', { name: 'บันทึก' }).click();
  await expect(row(page, '5190')).toContainText('ค่าใช้จ่ายเบ็ดเตล็ด');
  const rows = await api<{ items: { code: string; parent?: string; inUse: boolean; version: number }[] }>(page, '/records/account?active=all&limit=100');
  expect(rows.items.find((r) => r.code === '5190')).toMatchObject({ parent: '5000', inUse: false, version: 1 });

  // 1130 is the receivable role's account: switching it off is refused, naming the rule and the exit
  await row(page, '1130').getByRole('button', { name: 'ปิดใช้งาน' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'ปิดใช้งาน' }).click();
  const refusal = page.getByRole('alert').filter({ hasText: 'กฎการลงบัญชี' });
  await expect(refusal).toContainText('“AR”');
  await expect(refusal).toContainText('แก้ที่ ตั้งค่า → การลงบัญชี');
  await shot(page, 'coa-refusal');
  await expect(row(page, '1130')).toContainText('ใช้งาน');

  // the unused new account CAN be switched off; then no new journal voucher can pick it
  await row(page, '5190').getByRole('button', { name: 'ปิดใช้งาน' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'ปิดใช้งาน' }).click();
  await expect(row(page, '5190')).toHaveCount(0); // the default filter shows active accounts
  const jv = await api<{ code: string }[]>(page, '/accounting/journal-accounts');
  expect(jv.some((a) => a.code === '5190')).toBe(false);
  expect(jv.some((a) => a.code === '5120')).toBe(true);
});

test('a used account keeps its code, class and posting flag locked; its name can still change', async ({ page }) => {
  await page.goto(BASE);
  await row(page, '1130').getByRole('button', { name: '1130' }).click();
  const dlg = page.getByRole('dialog', { name: 'แก้ไขผังบัญชี' });
  await expect(dlg.getByLabel('รหัส')).toHaveAttribute('readonly', '');
  await expect(dlg.getByLabel('หมวดบัญชี')).toBeDisabled();
  await expect(dlg.getByLabel('ประเภทย่อย')).toBeDisabled();
  await expect(dlg.getByText('แก้ไม่ได้หลังจากใช้ในเอกสารแล้ว').first()).toBeVisible();
  await dlg.getByLabel('ชื่อ (อังกฤษ)').fill('Trade receivables');
  await dlg.getByRole('button', { name: 'บันทึก' }).click();
  await expect(dlg).toHaveCount(0);
  const r = await api<{ nameEn: string; version: number }>(page, '/records/account/1130');
  expect(r).toMatchObject({ nameEn: 'Trade receivables', version: 2 });
});

test('mobile (390x844): the chart scrolls inside its card, the page does not', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(BASE);
  await expect(row(page, '1130')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await shot(page, 'coa-mobile');
  await axeClean(page);
});
