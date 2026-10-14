import { expect, test } from '@playwright/test';
import { fixtureId } from './helpers/fixtures';
import { screenContract } from './helpers/screen-contract';

screenContract({ name: 'TI list', path: '/sales/tax-invoices', heading: 'ใบกำกับภาษี', company: 'vat',
  states: ['empty', 'loading', 'error', 'forbidden'], forbiddenRole: 'admin', roles: ['operator', 'accountant'] });
screenContract({ name: 'TI view (filing lock)', path: async (p) => `/sales/tax-invoices/${await fixtureId(p, 'tiFilingLocked')}`,
  heading: /TI-\d{6}-\d{4}/, company: 'vat', states: ['loading', 'error', 'forbidden', 'locked'] });

test('a render error shows the app error state with retry, not the bare Next page', async ({ page }) => {
  await page.goto('/sales/tax-invoices/%zz');
  await expect(page.getByText('Application error')).toHaveCount(0);
});
test('breadcrumbs show the document number, never the raw id', async ({ page }) => {
  const id = await (async () => { await page.goto('/'); return fixtureId(page, 'tiIssuedUnpaid'); })();
  await page.goto(`/sales/tax-invoices/${id}`);
  const crumbs = page.getByRole('navigation', { name: 'breadcrumb' });
  await expect(crumbs).toContainText(/TI-\d{6}-\d{4}/);
  await expect(crumbs).not.toContainText(id);
});
test('390 px: the paper tab scrolls inside its container; the page itself never scrolls sideways', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/'); const id = await fixtureId(page, 'tiIssuedUnpaid');
  await page.goto(`/sales/tax-invoices/${id}`);
  await expect(page.getByRole('tab', { name: 'กระดาษ' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  const box = page.getByRole('region', { name: 'กระดาษ' });
  expect(await box.evaluate((e) => e.scrollWidth > e.clientWidth && getComputedStyle(e).overflowX === 'auto')).toBe(true);
});
