import { expect, test } from '@playwright/test';
import { screenContract } from './helpers/screen-contract';
import { axeClean } from './helpers/axe';
import { fixtureId } from './helpers/fixtures';

test.afterEach(async ({ page }) => { await axeClean(page); });
screenContract({ name: 'trial balance', path: '/reports/financial-statements?tab=tb', heading: 'งบการเงิน', company: 'both', states: ['empty', 'loading', 'error', 'forbidden'], forbiddenRole: 'operator' });
test('TB totals are equal and shown as baht', async ({ page }) => {
  await page.goto('/reports/financial-statements?tab=tb');
  const total = page.getByRole('row', { name: /รวม/ });
  await expect(total).toBeVisible();
  const cells = await total.getByRole('cell').allTextContents();
  expect(cells.at(-1)).toBe(cells.at(-2));
  expect(cells.at(-1)).toMatch(/^\d{1,3}(,\d{3})*\.\d{2}$/);
});
test('corrupted journal displays a non-zero tie-out banner', async ({ page }) => {
  await page.goto('/reports/financial-statements?tab=tb');
  const id = await fixtureId(page, 'tiIssuedUnpaid');
  await page.evaluate(async (id) => {
    await fetch('/bff/v1/mock/persist', { method: 'POST' });
    const key = Object.keys(localStorage).find((k) => k.startsWith('teas2.mock.state.'))!; // the versioned key follows the seed (v20 now)
    const state = JSON.parse(localStorage.getItem(key)!);
    const journal = state.journals.find((j: { docId: string }) => j.docId === id);
    const line = journal.preview.entries.flatMap((e: { lines: { accountCode: string; debit: string }[] }) => e.lines).find((l: { accountCode: string }) => l.accountCode === '1130');
    line.debit = '0.00';
    localStorage.setItem(key, JSON.stringify(state));
  }, id);
  await page.reload();
  const banner = page.getByRole('status', { name: 'ยอดกระทบไม่ตรงกัน' });
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('เดบิต');
  await expect(banner).toContainText('เครดิต');
});
test('CSV export downloads text with a BOM and CRLF, Thai intact', async ({ page }) => {
  await page.goto('/reports/financial-statements?tab=tb');
  await expect(page.getByRole('row', { name: /รวม/ })).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'ส่งออก CSV' }).click()]);
  expect(download.suggestedFilename()).toBe('trial-balance.csv');
  const bytes = await (await import('node:fs/promises')).readFile((await download.path())!);
  expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  const text = bytes.toString('utf8').slice(1);
  expect(text.startsWith('รหัสบัญชี,ชื่อบัญชี,เดบิต,เครดิต\r\n')).toBe(true);
  expect(text.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
});
