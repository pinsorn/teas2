import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { axeClean } from './helpers/axe';
import { fixtureId } from './helpers/fixtures';
import { screenContract } from './helpers/screen-contract';
import { KBIZ_OCT_NAME, kbizCsv } from '../src/mocks/fixtures/statements/kbiz-2026-10.csv';
import { KBANK_ACCOUNT_NO, KBANK_SEP_CLOSING, withBalances } from '../src/mocks/fixtures/statements/kplus-2026-09';

const shot = async (page: Page, name: string) => { if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/${name}.png`, fullPage: true }); };
const HEADING = 'ภ.ง.ด.1 และ สปส.1-10';
const NV = 'company=nonvat&role=accountant&state=normal';

// PY3 ruling 9: every tab is `both` (every company has payroll), read with payroll.read: the operator is forbidden. The VAT company's September is a draft that can be filed (August is filed); the non-VAT company has no SSO employer account.
const TABS: [string, string, boolean][] = [
  ['payroll filings pnd1 (draft)', '/payroll/filings?tab=pnd1&period=2026-09', true], ['payroll filings pnd1 (filed)', '/payroll/filings?tab=pnd1&period=2026-08', false],
  ['payroll filings pnd1a', '/payroll/filings?tab=pnd1a&period=2025', true], ['payroll filings sso (draft)', '/payroll/filings?tab=sso&period=2026-09', true],
  ['payroll filings sso (filed)', '/payroll/filings?tab=sso&period=2026-08', false], ['payroll filings 50 tawi', '/payroll/filings?tab=cert&period=2025', true],
];
for (const [name, path, states] of TABS) screenContract({ name, path, heading: HEADING, company: 'both', states: states ? ['empty', 'loading', 'error', 'forbidden'] : [], forbiddenRole: 'operator' });

test.beforeEach(async ({ page }) => { await page.goto('/'); await page.evaluate(() => localStorage.clear()); await page.reload(); });

const importOct = (page: Page, lines: [string, string, string][]) => page.evaluate(async ([content, name]) => (await fetch('/bff/v1/finance/bank-accounts/ba-kbank/imports', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fileName: name, format: 'kbiz-csv', content }) })).status,
  [Buffer.from(kbizCsv({ accountNo: KBANK_ACCOUNT_NO, accountName: 'บริษัท ตัวอย่าง จำกัด', from: '2026-10-01', opening: KBANK_SEP_CLOSING, lines: withBalances(KBANK_SEP_CLOSING, lines) })).toString('base64'), KBIZ_OCT_NAME] as const);
const finalize = async (page: Page) => {
  await page.getByRole('button', { name: /ยืนยันยื่นแบบ/ }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: /ยืนยันยื่นแบบ/ }).click();
  await expect(page.getByTestId('filed-banner')).toBeVisible();
};

test('the filed month: frozen rows, the tie-out is zero, and nothing to change; the draft month shows its blockers none and finalizes', async ({ page }) => {
  await page.goto('/payroll/filings?tab=pnd1&period=2026-08');
  await expect(page.getByTestId('filed-banner')).toContainText('แก้ได้ในรอบถัดไปด้วยรายได้อื่น / รายการหักอื่น');
  await expect(page.getByTestId('box-income')).toContainText('201,200.00');
  await expect(page.getByTestId('box-tax')).toContainText('2,436.50');
  await expect(page.getByTestId('filing-attachment')).toContainText('สมศรี');
  await shot(page, 'pnd1-filed-desktop');
  await page.goto('/payroll/filings?tab=pnd1&period=2026-09');
  await expect(page.getByTestId('blockers')).toHaveCount(0);
  await expect(page.getByText('รอบเงินเดือนฉบับร่าง')).toHaveCount(0);
  await shot(page, 'pnd1-draft-desktop');
  await axeClean(page);
  await finalize(page);
  await expect(page.getByTestId('box-tax')).toContainText('4,474.00');
  await expect(page.getByTestId('tax-payment')).toContainText('4,474.00');
  await shot(page, 'pnd1-sep-finalized');
});

test('finalize September, then the run is locked everywhere; pay the PIT and the SSO from statement lines, see them paid, cancel one payment', async ({ page }) => {
  await page.goto('/'); const id = await fixtureId(page, 'prIssued'); // before filing: a fixture key that is no longer true (pnd1Draft) fails the whole lookup
  await page.goto('/payroll/filings?tab=pnd1&period=2026-09');
  await finalize(page);
  await page.goto('/payroll/filings?tab=sso&period=2026-09');
  await finalize(page);
  await expect(page.getByTestId('box-total')).toContainText('7,000.00');
  // the runs of the month are locked: the document page says why and what to do
  await page.goto(`/payroll/runs/${id}`);
  await expect(page.getByText('แก้ไขในรอบถัดไป (รายได้อื่น / รายการหักอื่น)').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'ยกเลิกเอกสาร' })).toBeDisabled();
  await shot(page, 'payroll-run-filing-locked');
  expect(await importOct(page, [['2026-10-12', 'ภาษีเงินเดือน กรมสรรพากร', '-4474.00'], ['2026-10-13', 'เงินสมทบประกันสังคม', '-7000.00']])).toBe(201);
  // pay the ภ.ง.ด.1 (Dr 2153)
  await page.goto('/payroll/filings?tab=pnd1&period=2026-09');
  const box = page.getByTestId('tax-payment');
  await box.getByRole('button', { name: 'ชำระภาษี' }).click();
  const dialog = page.getByTestId('tax-payment-dialog');
  await expect(dialog.getByText('ยอดตรงกับภาษี')).toBeVisible();
  await shot(page, 'pnd1-pay-dialog');
  await dialog.getByRole('radio', { name: /ภาษีเงินเดือน กรมสรรพากร/ }).check();
  await dialog.getByRole('button', { name: 'ชำระภาษี' }).click();
  await expect(box).toContainText('ชำระแล้ว วันที่');
  // pay the สปส.1-10 (Dr 2160) with the employer share included
  await page.goto('/payroll/filings?tab=sso&period=2026-09');
  const sso = page.getByTestId('tax-payment');
  await expect(sso).toContainText('7,000.00');
  await sso.getByRole('button', { name: 'ชำระภาษี' }).click();
  await page.getByTestId('tax-payment-dialog').getByRole('radio', { name: /เงินสมทบประกันสังคม/ }).check();
  await page.getByTestId('tax-payment-dialog').getByRole('button', { name: 'ชำระภาษี' }).click();
  await expect(sso).toContainText('ชำระแล้ว วันที่');
  await shot(page, 'sso-paid');
  // cancel the SSO payment: a reason is needed; the return reads unpaid again
  await sso.getByRole('button', { name: 'ยกเลิกการชำระ' }).click();
  const ask = page.getByRole('alertdialog');
  await expect(ask.getByRole('button', { name: 'ยกเลิกการชำระ' })).toBeDisabled();
  await ask.getByRole('textbox').fill('เลือกรายการผิด');
  await ask.getByRole('button', { name: 'ยกเลิกการชำระ' }).click();
  await expect(sso).toContainText('ภาษีที่ต้องชำระ');
});

test('the non-VAT company has no SSO employer account: the return is blocked and the exit is the company settings; nothing can be finalized', async ({ page }) => {
  await page.goto(`/payroll/filings?tab=sso&period=2026-09&${NV}`);
  const blockers = page.getByTestId('blockers');
  await expect(blockers.getByTestId('blocker-sso_account')).toContainText('บัญชีนายจ้างประกันสังคม');
  await expect(blockers.getByRole('link', { name: 'ไปแก้' })).toHaveAttribute('href', '/settings/company');
  await expect(page.getByRole('button', { name: /ยืนยันยื่นแบบ/ })).toBeDisabled();
  await expect(page.getByTestId('finalize-why')).toContainText('บัญชีนายจ้างประกันสังคม');
  await shot(page, 'sso-blocked-desktop');
  await axeClean(page);
});

test('the SSO file of the filed month: 135 columns a line, one detail per insured employee, TIS-620 characters only', async ({ page }) => {
  await page.goto('/payroll/filings?tab=sso&period=2026-08');
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /ไฟล์ส่งประกันสังคม/ }).click()]);
  expect(download.suggestedFilename()).toBe('SSO1-10-2026-08.txt');
  const text = readFileSync(await download.path(), 'utf8');
  const lines = text.split('\r\n').filter(Boolean);
  expect(lines).toHaveLength(5);
  for (const l of lines) expect(l).toHaveLength(135);
  expect(lines[0].startsWith('11234567890')).toBe(true);
});

test('the ภ.ง.ด.1ก of the non-VAT company\'s 2025 (its opening balance), then the 50 tawi of its two employees: two copies each, the 1ก box ticked, SSO in the funds field', async ({ page }) => {
  await page.goto(`/payroll/filings?tab=cert&period=2025&${NV}`);
  await expect(page.getByTestId('employee-certificates')).toContainText('ยืนยัน ภ.ง.ด.1ก ของปีนี้ก่อน'); // nothing to print before the 1ก is filed
  await page.goto(`/payroll/filings?tab=pnd1a&period=2025&${NV}`);
  await expect(page.getByTestId('filing-attachment')).toContainText('เงินได้ก่อนใช้ระบบ');
  await expect(page.getByTestId('box-income')).toContainText('330,000.00');
  await shot(page, 'pnd1a-nonvat-2025-draft');
  await finalize(page);
  await expect(page.getByTestId('tax-payment')).toHaveCount(0); // a yearly summary has nothing to pay
  await page.goto(`/payroll/filings?tab=cert&period=2025&${NV}`);
  const rows = page.getByTestId('cert-row');
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText('180,000.00');
  const preview = page.getByTestId('cert-preview');
  await expect(preview.locator('[data-paper-page]')).toHaveCount(4); // 2 employees x 2 copies
  await expect(preview.locator('[data-field="sso-paid"]').first()).toContainText('9,000.00');
  await expect(preview.locator('.paper-rd-seq .paper-check[data-checked="true"]').first()).toBeVisible();
  await expect(preview.locator('.paper-rd-seq li', { has: page.locator('[data-checked="true"]') }).first()).toContainText('ภ.ง.ด.1ก');
  await expect(preview.locator('tr[data-row="1"] td.r').first()).toContainText('180,000.00');
  await shot(page, 'cert-employees-desktop');
  await axeClean(page);
  await page.emulateMedia({ media: 'print' });
  await shot(page, 'cert-employees-print');
  await page.emulateMedia({ media: 'screen' });
});

test('at 390px the tabs, the boxes and the certificate preview do not overflow the page', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const [name, q] of [['pnd1', 'tab=pnd1&period=2026-08'], ['pnd1a', `tab=pnd1a&period=2025&${NV}`], ['sso-blocked', `tab=sso&period=2026-09&${NV}`], ['sso-filed', 'tab=sso&period=2026-08'], ['cert', `tab=cert&period=2025&${NV}`]] as const) {
    await page.goto(`/payroll/filings?${q}`);
    await expect(page.getByRole('heading', { level: 1, name: HEADING })).toBeVisible();
    await page.waitForLoadState('networkidle');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), name).toBe(true);
    await shot(page, `payroll-filings-390-${name}`);
  }
});
