import { expect, test, type Page } from '@playwright/test';
import { axeClean } from './helpers/axe';
import { fixtureId } from './helpers/fixtures';

const PR = '/payroll/runs';
const shot = async (page: Page, name: string) => { if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/${name}.png`, fullPage: true }); };

test.beforeEach(async ({ page }) => { await page.goto('/'); await page.evaluate(() => localStorage.clear()); await page.reload(); });

test('pay the latest run: the account is required (several exist), the amount is the stored net, the run settles; edit and cancel say why not; unpay needs a reason and brings it back', async ({ page }) => {
  await page.goto('/'); const id = await fixtureId(page, 'prIssued');
  const run = await page.evaluate(async (i) => (await (await fetch(`/bff/v1/docs/PR/${i}`)).json()), id) as { totals: { net: string } };
  await page.goto(`${PR}/${id}`);
  await page.getByRole('button', { name: 'จ่ายเงินเดือน', exact: true }).click();
  const dlg = page.getByRole('dialog', { name: /จ่ายเงินเดือน PR-/ });
  await expect(dlg.getByTestId('pay-amount')).toHaveText(Number(run.totals.net).toLocaleString('en-US', { minimumFractionDigits: 2 })); // the run's stored net, not typed
  await shot(page, 'payroll-pay-dialog');
  const submit = dlg.getByRole('button', { name: 'จ่ายเงินเดือน', exact: true });
  const acct = dlg.getByLabel('บัญชีที่จ่าย');
  await acct.selectOption('');
  await expect(submit).toBeDisabled(); // several active accounts: none is chosen for you unless one is the default
  await acct.selectOption('ba-kbank');
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'ยกเลิกการจ่าย', exact: true })).toBeVisible();
  await expect(page.getByText('ชำระครบ').first()).toBeVisible();
  await expect(page.getByRole('link', { name: 'แก้ไข', exact: true })).toHaveCount(0); // edit is disabled, not a link
  await expect(page.getByRole('button', { name: 'ยกเลิกเอกสาร' })).toBeDisabled();
  await page.getByRole('tab', { name: 'ผลต่อบัญชี' }).click();
  await expect(page.getByRole('tabpanel')).toContainText('2170');
  await shot(page, 'payroll-paid');
  await axeClean(page);

  await page.getByRole('button', { name: 'ยกเลิกการจ่าย', exact: true }).click();
  const un = page.getByRole('dialog', { name: /ยกเลิกการจ่ายเงินเดือน PR-/ });
  await expect(un.getByRole('button', { name: 'ยกเลิกการจ่าย', exact: true })).toBeDisabled(); // no reason, no unpay
  await un.getByLabel('เหตุผล').fill('จ่ายผิดบัญชี');
  await shot(page, 'payroll-unpay-dialog');
  await un.getByRole('button', { name: 'ยกเลิกการจ่าย', exact: true }).click();
  await expect(page.getByRole('button', { name: 'จ่ายเงินเดือน', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'ยกเลิกเอกสาร' })).toBeEnabled();
});

test('the pay dialog shows the server\'s refusal in place (a date before the run) and writes nothing', async ({ page }) => {
  await page.goto('/'); const id = await fixtureId(page, 'prIssued');
  await page.goto(`${PR}/${id}`);
  await page.getByRole('button', { name: 'จ่ายเงินเดือน', exact: true }).click();
  const dlg = page.getByRole('dialog');
  await dlg.getByLabel('บัญชีที่จ่าย').selectOption('ba-kbank');
  await dlg.getByLabel('วันที่จ่าย').evaluate((el: HTMLInputElement) => { el.removeAttribute('min'); });
  await dlg.getByLabel('วันที่จ่าย').fill('2026-09-01');
  await dlg.getByRole('button', { name: 'จ่ายเงินเดือน', exact: true }).click();
  await expect(dlg.getByRole('alert')).toContainText('ต้องไม่ก่อนวันที่ของรอบเงินเดือน');
  await expect(dlg).toBeVisible();
});

test('the paid seed run: the payslip drawer shows the stored figures (no computing), the 50 tawi note and prints that one slip', async ({ page, context }) => {
  await page.goto('/'); const id = await fixtureId(page, 'prPaid');
  await page.goto(`${PR}/${id}`);
  await expect(page.getByText('ชำระครบ').first()).toBeVisible(); // paid by the seed through the command
  await expect(page.getByRole('button', { name: 'ยกเลิกการจ่าย', exact: true })).toBeVisible();
  const row = page.getByTestId('payroll-summary-row').first();
  const gross = (await row.locator('td').nth(1).textContent())!, net = (await row.locator('td').nth(5).textContent())!;
  await row.getByRole('button', { name: /^ดูใบจ่ายเงินเดือนของ/ }).click();
  const drawer = page.getByTestId('payslip-drawer');
  await expect(drawer.getByTestId('slip-gross')).toHaveText(gross);
  await expect(drawer.getByTestId('slip-net')).toHaveText(net);
  for (const k of ['pit', 'sso', 'otherDeduction', 'ssoEmployer', 'ytdIncome', 'ytdPit', 'ytdSso']) await expect(drawer.getByTestId(`slip-${k}`)).not.toHaveText('');
  await expect(drawer).toContainText('หนังสือรับรองตามมาตรา 50 ทวิ ออกให้ปีละครั้ง (ภ.ง.ด.1ก)');
  await shot(page, 'payroll-drawer');
  await axeClean(page);
  const popup = context.waitForEvent('page');
  await drawer.getByRole('link', { name: 'พิมพ์ใบจ่ายเงินเดือน' }).click();
  const p2 = await popup;
  await p2.waitForLoadState();
  await expect(p2.locator('[data-payslip]')).toHaveCount(1);
  await expect(p2.locator('[data-payslip]')).toContainText(net);
});

test('print all slips of a run: one A5 sheet per employee, a page break between, the net of each from the model; the paper scrolls inside its container on a phone', async ({ page }) => {
  await page.goto('/'); const id = await fixtureId(page, 'prPaid');
  const run = await page.evaluate(async (i) => (await (await fetch(`/bff/v1/docs/PR/${i}`)).json()), id) as { payroll: { slips: { net: string }[] } };
  await page.goto(`/print/PR/${id}`);
  const sheets = page.locator('[data-payslip]');
  await expect(sheets).toHaveCount(run.payroll.slips.length);
  for (const [i, s] of run.payroll.slips.entries()) await expect(sheets.nth(i)).toContainText(Number(s.net).toLocaleString('en-US', { minimumFractionDigits: 2 }));
  await shot(page, 'payslip-paper-desktop');
  await page.emulateMedia({ media: 'print' });
  const info = await sheets.first().evaluate((el) => { const s = getComputedStyle(el); return { page: s.getPropertyValue('page'), w: el.getBoundingClientRect().width, brk: s.breakAfter }; });
  expect(info.page).toBe('payslip');
  expect(Math.round(info.w)).toBe(559); // A5 wide (148 mm) at 96 dpi
  expect(info.brk).toBe('page');
  await shot(page, 'payslip-paper-print');
  await page.emulateMedia({ media: 'screen' });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(over).toBeLessThanOrEqual(0); // the page itself does not scroll sideways ...
  const inner = await page.locator('.overflow-x-auto').first().evaluate((el) => el.scrollWidth > el.clientWidth); // ... the paper does, inside its container
  expect(inner).toBe(true);
  await shot(page, 'payslip-paper-mobile');
});

test('mobile: the pay dialog and the drawer fit a 390 px screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/'); const id = await fixtureId(page, 'prIssued');
  await page.goto(`${PR}/${id}`);
  await page.getByRole('button', { name: 'จ่ายเงินเดือน', exact: true }).click();
  const dlg = page.getByRole('dialog');
  await expect(dlg.getByRole('button', { name: 'จ่ายเงินเดือน', exact: true })).toBeVisible();
  const box = await dlg.boundingBox();
  expect(box!.width).toBeLessThanOrEqual(390);
  await shot(page, 'payroll-pay-dialog-mobile');
  await dlg.getByRole('button', { name: 'กลับ' }).click();
  await page.getByTestId('payroll-summary-row').first().getByRole('button', { name: /^ดูใบจ่ายเงินเดือนของ/ }).click();
  await expect(page.getByTestId('payslip-drawer')).toBeVisible();
  const w = (await page.getByTestId('payslip-drawer').boundingBox())!.width;
  expect(w).toBeLessThanOrEqual(390);
  await shot(page, 'payroll-drawer-mobile');
});
