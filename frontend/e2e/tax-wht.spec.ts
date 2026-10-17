import { expect, test, type Page } from '@playwright/test';
import { axeClean } from './helpers/axe';
import { fixtureId } from './helpers/fixtures';
import { screenContract } from './helpers/screen-contract';

const shot = async (page: Page, name: string) => { if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/${name}.png`, fullPage: true }); };
const HEADING = 'ภ.ง.ด. หัก ณ ที่จ่าย และ ภ.พ.36';

// TX2b: the hub is the accountant's (tax.read): the operator is forbidden. Every company has the withholding returns, so every tab is `both`. The WT list's own contract is in purchases-pv.spec.
const TABS: [string, string][] = [
  ['WHT hub pnd3', '/tax/wht'], ['WHT hub pnd53 (filed)', '/tax/wht?tab=pnd53&period=2026-09'], ['WHT hub pnd53 (blocked)', '/tax/wht?tab=pnd53&period=2026-10'],
  ['WHT hub pnd2', '/tax/wht?tab=pnd2'], ['WHT hub pnd54', '/tax/wht?tab=pnd54&period=2026-10'], ['WHT hub pp36', '/tax/wht?tab=pp36&period=2026-10'],
  ['WHT hub withheld', '/tax/wht?tab=withheld'], ['WHT hub missing', '/tax/wht?tab=missing'],
];
for (const [name, path] of TABS) screenContract({ name, path, heading: HEADING, company: 'both', states: ['empty', 'loading', 'error', 'forbidden'], forbiddenRole: 'operator' });

test.beforeEach(async ({ page }) => { await page.goto('/'); await page.evaluate(() => localStorage.clear()); await page.reload(); });

/** Test setup: drop one finalized filing from the persisted mock state so that its month is a draft again (the seed has no finalizable withholding return: August and September are filed, October is still open). */
async function dropFiling(page: Page, form: string, period: string) {
  await fixtureId(page, 'pnd53Draft');
  await page.evaluate(() => fetch('/bff/v1/mock/persist', { method: 'POST' }));
  await page.evaluate(([f, p]) => {
    const key = Object.keys(localStorage).find((k) => k.startsWith('teas2.mock.state'))!;
    const s = JSON.parse(localStorage.getItem(key)!) as { filings: { form: string; period: string }[] };
    s.filings = s.filings.filter((x) => !(x.form === f && x.period === p));
    localStorage.setItem(key, JSON.stringify(s));
  }, [form, period]);
  await page.reload();
}

test('a filed month (2026-09) reads as the frozen snapshot: boxes with the payee count, the attachment, tie-out, the RD Prep file', async ({ page }) => {
  await page.goto('/');
  expect(await fixtureId(page, 'pnd53Draft')).toBe('2026-10');
  await page.goto('/tax/wht?tab=pnd53&period=2026-09');
  await expect(page.getByRole('heading', { level: 1, name: HEADING })).toBeVisible();
  await expect(page.getByTestId('filed-banner')).toContainText('ยื่นแล้ว');
  await expect(page.getByTestId('box-payees')).toContainText('ราย');
  await expect(page.getByTestId('box-tax')).toContainText('450.00');
  await expect(page.getByTestId('filing-attachment').getByRole('row')).not.toHaveCount(1);
  await expect(page.getByRole('status', { name: 'ยอดกระทบไม่ตรงกัน' })).toHaveCount(0);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: /RD Prep/ }).click();
  expect((await download).suggestedFilename()).toBe('PND53-2026-09.txt');
  await expect(page.getByTestId('filing-history').getByRole('link')).toHaveCount(2);
  await axeClean(page);
  await shot(page, 'wht-pnd53-filed');
});

test('2026-10 lists its blockers; the ภ.ง.ด.54 has no RD Prep file; the ภ.พ.36 lists its voucher and VAT', async ({ page }) => {
  await page.goto('/tax/wht?tab=pnd53&period=2026-10');
  await expect(page.getByTestId('blocker-period_not_ended')).toBeVisible();
  await expect(page.getByRole('button', { name: /ยืนยันยื่นแบบ/ })).toBeDisabled();
  await page.getByRole('tab', { name: 'ภ.ง.ด.54' }).click();
  await expect(page).toHaveURL(/tab=pnd54/);
  await expect(page.getByTestId('box-payees')).toBeVisible();
  await expect(page.getByRole('button', { name: /RD Prep/ })).toHaveCount(0);
  await page.getByRole('tab', { name: 'ภ.พ.36' }).click();
  await page.goto('/tax/wht?tab=pp36&period=2026-10');
  await expect(page.getByTestId('box-vat')).toContainText('700.00');
  await expect(page.getByTestId('filing-attachment')).toContainText('Cloudberry');
  await shot(page, 'wht-pp36-draft');
});

test('finalize a ภ.ง.ด.53 draft, then its voucher carries the filing lock with the "new voucher next month" exit', async ({ page }) => {
  await dropFiling(page, 'PND53', '2026-09');
  await page.goto('/tax/wht?tab=pnd53&period=2026-09');
  await expect(page.getByTestId('filed-banner')).toHaveCount(0);
  await page.getByRole('button', { name: /ยืนยันยื่นแบบ/ }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText('ภ.ง.ด.53');
  await shot(page, 'wht-pnd53-confirm');
  await dialog.getByRole('button', { name: /ยืนยันยื่นแบบ/ }).click();
  await expect(page.getByTestId('filed-banner')).toBeVisible();
  await page.goto('/purchases/payment-vouchers/pv-sep-53'); // the September voucher the return took
  const lock = page.locator('[data-screen-state="locked"]');
  await expect(lock).toContainText('ภ.ง.ด.53 เดือน ก.ย. 2569 ยื่นแล้ว');
  await expect(lock).toContainText('ออกใบสำคัญจ่ายใหม่ในงวดถัดไป');
  await shot(page, 'wht-pv-locked');
});

test('missing 50 tawi: the tab badge counts the list; entering the number on the receipt shrinks it', async ({ page }) => {
  await page.goto('/');
  const id = await fixtureId(page, 'missingCertRc');
  await page.goto('/tax/wht?tab=missing');
  await expect(page.getByTestId('missing-badge')).toHaveText('1');
  const row = page.getByRole('table').getByRole('link', { name: /RC-/ });
  await expect(row).toHaveAttribute('href', `/sales/receipts/${id}`);
  await shot(page, 'wht-missing');
  await page.goto(`/sales/receipts/${id}/edit`);
  await page.getByRole('textbox', { name: /^เลขที่หนังสือรับรองของ/ }).fill('ท.2569/0888');
  await page.getByRole('button', { name: 'บันทึกการแก้ไข' }).click();
  await page.getByRole('alertdialog', { name: /แผนการแก้ไข/ }).getByRole('button', { name: 'ยืนยันทั้งหมด' }).click();
  await expect(page.getByTestId('doc-number')).toBeVisible();
  await page.goto('/tax/wht?tab=missing');
  await expect(page.getByTestId('missing-badge')).toHaveCount(0);
  await expect(page.getByRole('table')).toHaveCount(0);
  await page.getByRole('tab', { name: 'ภาษีถูกหัก' }).click();
  await expect(page.getByRole('table').getByText('ท.2569/0888')).toBeVisible();
});

test('the tax withheld by customers lists by month with the certificate number and ties to ledger 1180', async ({ page }) => {
  await page.goto('/tax/wht?tab=withheld');
  const table = page.getByRole('table');
  await expect(table).toContainText('ท.2569/0451');
  await expect(table).toContainText('330.00');
  await expect(page.getByRole('status', { name: 'ยอดกระทบไม่ตรงกัน' })).toHaveCount(0);
  await expect(page.getByText('ยอดกระทบตรงกัน')).toBeVisible();
  await axeClean(page);
  await shot(page, 'wht-withheld');
});

test('the WT list has number, date, payee, return, income, tax and status; a saved view filters by return', async ({ page }) => {
  await page.goto('/tax/wht-certificates');
  const head = page.getByRole('table').getByRole('columnheader');
  await expect(head).toContainText(['เลขที่', 'วันที่', 'ผู้รับเงิน', 'แบบที่ยื่น', 'เงินได้', 'ภาษีที่หัก', 'สถานะ']);
  const all = await page.getByRole('table').getByRole('row').count();
  await page.getByRole('button', { name: 'ภ.ง.ด.53' }).click();
  await expect(page).toHaveURL(/form=PND53/);
  await expect.poll(async () => page.getByRole('table').getByRole('row').count()).toBeLessThan(all);
  const cells = await page.getByRole('table').getByRole('row').filter({ hasText: /WT-/ }).allInnerTexts();
  expect(cells.length).toBeGreaterThan(0);
  for (const c of cells) expect(c).toContain('ภ.ง.ด.53');
  await shot(page, 'wht-wt-list');
});

test('390 px never scrolls sideways (a filed return with its attachment, the receivable)', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const path of ['/tax/wht?tab=pnd53&period=2026-09', '/tax/wht?tab=withheld', '/tax/wht?tab=pp36&period=2026-10']) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1, name: HEADING })).toBeVisible();
    await expect(page.getByRole('table').first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await shot(page, `wht-390-${path.split('tab=')[1].split('&')[0]}`);
  }
});
