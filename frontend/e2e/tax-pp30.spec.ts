import { expect, test, type Page } from '@playwright/test';
import { axeClean } from './helpers/axe';
import { fixtureId } from './helpers/fixtures';
import { screenContract } from './helpers/screen-contract';

const shot = async (page: Page, name: string) => { if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/${name}.png`, fullPage: true }); };

// TX1: the ภ.พ.30 page is the accountant's (tax.read): the operator is forbidden; a filing page has no lock state (a finalized period shows the read-only "ยื่นแล้ว" banner instead)
screenContract({ name: 'VAT return and registers', path: '/tax/vat?period=2026-10', heading: 'ภ.พ.30 และทะเบียนภาษี', company: 'vat', states: ['empty', 'loading', 'error', 'forbidden'], forbiddenRole: 'operator' });

test.beforeEach(async ({ page }) => { await page.goto('/'); await page.evaluate(() => localStorage.clear()); await page.reload(); });

test('2026-10 lists its blockers with links; the previous month link opens 2026-09, which can be confirmed', async ({ page }) => {
  await page.goto('/');
  expect(await fixtureId(page, 'pp30Draft')).toBe('2026-10');
  await page.goto('/tax/vat?period=2026-10');
  await expect(page.getByRole('heading', { level: 1, name: 'ภ.พ.30 และทะเบียนภาษี' })).toBeVisible();
  await expect(page.getByTestId('blockers')).toBeVisible();
  await expect(page.getByTestId('blocker-draft_document').first().getByRole('link', { name: 'ไปแก้' })).toHaveAttribute('href', /\/edit$/);
  await expect(page.getByTestId('finalize-why')).toContainText('ยืนยันไม่ได้:');
  await expect(page.getByRole('button', { name: /ยืนยันยื่นแบบ/ })).toBeDisabled();
  await shot(page, 'pp30-blocked');
  await page.getByTestId('blocker-previous_open').getByRole('link', { name: 'ไปแก้' }).click();
  await expect(page).toHaveURL(/period=2026-09/);
  await expect(page.getByRole('heading', { level: 2, name: /ก\.ย\. 2569/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /ยืนยันยื่นแบบ/ })).toBeEnabled();
});

test('a filed month (2026-08) reads as the frozen snapshot: banner, no finalize, the RD Prep file; its history lists 2026-07 and 2026-08', async ({ page }) => {
  await page.goto('/');
  expect(await fixtureId(page, 'pp30Finalized')).toBe('2026-08');
  await page.goto('/tax/vat?period=2026-08');
  await expect(page.getByTestId('filed-banner')).toContainText('ยื่นแล้ว');
  await expect(page.getByRole('button', { name: /ยืนยันยื่นแบบ/ })).toHaveCount(0);
  await expect(page.getByTestId('box-5')).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: /RD Prep/ }).click();
  expect((await download).suggestedFilename()).toBe('PP30-2026-08.txt');
  await expect(page.getByTestId('filing-history').getByRole('link')).toHaveCount(2);
  await axeClean(page);
  await shot(page, 'pp30-filed');
});

test('finalize 2026-09, then a September tax invoice carries the filing lock with the credit / debit note exit', async ({ page }) => {
  await page.goto('/');
  expect(await fixtureId(page, 'pp30Due')).toBe('2026-09');
  await page.goto('/tax/vat?period=2026-09');
  await page.getByRole('button', { name: /ยืนยันยื่นแบบ/ }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText('แก้ไขตัวเลขไม่ได้');
  await shot(page, 'pp30-confirm');
  await dialog.getByRole('button', { name: /ยืนยันยื่นแบบ/ }).click();
  await expect(page.getByTestId('filed-banner')).toBeVisible();
  await page.getByRole('tab', { name: 'ทะเบียนภาษีขาย' }).click();
  await expect(page).toHaveURL(/tab=output/);
  const first = page.getByRole('table').first().getByRole('link').first();
  await expect(first).toBeVisible();
  await first.click();
  const lock = page.locator('[data-screen-state="locked"]');
  await expect(lock).toContainText('ภ.พ.30 เดือน ก.ย. 2569 ยื่นแล้ว');
  await expect(lock.getByRole('button', { name: 'ออกใบลดหนี้ / ใบเพิ่มหนี้ในงวดถัดไป' })).toBeVisible();
  await shot(page, 'pp30-ti-locked');
});

test('the two registers list the month and tie to the ledger; 390 px never scrolls sideways', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/tax/vat?tab=input&period=2026-10');
  await expect(page.getByRole('heading', { level: 2, name: 'ทะเบียนภาษีซื้อ' })).toBeVisible();
  await expect(page.getByRole('table').first()).toBeVisible();
  await expect(page.getByRole('status', { name: 'ยอดกระทบไม่ตรงกัน' })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.goto('/tax/vat?tab=output&period=2026-08');
  await expect(page.getByRole('heading', { level: 2, name: 'ทะเบียนภาษีขาย' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await shot(page, 'pp30-output-mobile');
});
