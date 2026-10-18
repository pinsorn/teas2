import { expect, test, type Page } from '@playwright/test';
import { axeClean } from './helpers/axe';
import { screenContract } from './helpers/screen-contract';

const FS = '/reports/financial-statements';
const num = (t: string) => Number(t.replace(/,/g, ''));
const shot = async (page: Page, name: string) => { if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/${name}.png`, fullPage: true }); };
const api = <T,>(page: Page, path: string) => page.evaluate(async (p) => { const r = await fetch(`/bff/v1${p}`); return { status: r.status, json: await r.json().catch(() => undefined) }; }, path) as Promise<{ status: number; json: T }>;
type Model = { rows: { kind: string; cells: Record<string, string> }[]; columns: { key: string; label?: string }[]; tieOuts: { diff: string }[] };

// report.read is the accountant's and the owner's: the operator is forbidden on every tab
screenContract({ name: 'profit and loss', path: `${FS}?tab=pl`, heading: 'งบการเงิน', company: 'both', states: ['empty', 'loading', 'error', 'forbidden'], forbiddenRole: 'operator' });
screenContract({ name: 'balance sheet', path: `${FS}?tab=bs`, heading: 'งบการเงิน', company: 'both', states: ['empty', 'loading', 'error', 'forbidden'], forbiddenRole: 'operator' });
screenContract({ name: 'general ledger', path: `${FS}?tab=gl&account=1130`, heading: 'งบการเงิน', company: 'both', states: ['empty', 'loading', 'error', 'forbidden'], forbiddenRole: 'operator' });

test.afterEach(async ({ page }) => { await axeClean(page); });

test('P&L: a row drills into the GL with the same range; the GL ends at the P&L figure', async ({ page }) => {
  await page.goto(`${FS}?tab=pl&from=2026-01-01&to=2026-12-31`);
  const table = page.getByRole('table', { name: 'งบกำไรขาดทุน' });
  await expect(table).toBeVisible();
  await expect(table).toContainText('กำไรขั้นต้น');
  await expect(table).toContainText('กำไร (ขาดทุน) สุทธิ');
  await expect(page.getByText('ยอดกระทบตรงกัน').first()).toBeVisible();
  await shot(page, 'pl-desktop');
  const link = table.getByRole('link', { name: '5110' });
  const amount = (await link.locator('xpath=ancestor::tr').getByRole('cell').last().innerText()).trim();
  await link.click();
  await expect(page).toHaveURL(/tab=gl&account=5110&from=2026-01-01&to=2026-12-31/);
  const gl = page.getByRole('table', { name: 'บัญชีแยกประเภท' });
  await expect(gl).toContainText('ยอดยกมา');
  const closing = gl.getByRole('row').filter({ hasText: 'ยอดยกไป' });
  await expect(closing).toBeVisible();
  const cells = await closing.getByRole('cell').allInnerTexts(); // [.., debit, credit, balance]
  expect(num(cells.at(-3)!) - num(cells.at(-2)!)).toBeCloseTo(num(amount), 2); // the account's movement in the range IS the P&L figure of the row you came from
  await shot(page, 'gl-desktop');
});

test('P&L comparative, DBD format and CSV', async ({ page }) => {
  await page.goto(`${FS}?tab=pl&from=2026-07-01&to=2026-09-30&compare=previous`);
  const table = page.getByRole('table', { name: 'งบกำไรขาดทุน' });
  await expect(table.getByRole('columnheader', { name: 'ผลต่าง' })).toBeVisible();
  await expect(page.getByText('งวดเปรียบเทียบ:')).toBeVisible();
  await shot(page, 'pl-compare');
  await page.goto(`${FS}?tab=pl&from=2026-01-01&to=2026-12-31&format=dbd`);
  await expect(page.getByRole('table', { name: 'งบกำไรขาดทุน' })).toContainText('รายได้จากการขายหรือการให้บริการ');
  await shot(page, 'pl-dbd');
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'ส่งออก CSV' }).click()]);
  expect(download.suggestedFilename()).toBe('profit-loss.csv');
});

test('P&L by dimension: one column per project and "ไม่ระบุ"; Σ columns = the total column on the API', async ({ page }) => {
  await page.goto(`${FS}?tab=pl&from=2026-01-01&to=2026-12-31&groupBy=project&company=nonvat`);
  const table = page.getByRole('table', { name: 'งบกำไรขาดทุน' });
  for (const h of ['P-A', 'P-B', 'ไม่ระบุ']) await expect(table.getByRole('columnheader', { name: h })).toBeVisible();
  await expect(table.getByRole('link', { name: '4100' })).toBeVisible();
  await shot(page, 'pl-by-project');
  await page.setViewportSize({ width: 390, height: 844 });
  await shot(page, 'pl-by-project-390');
  const r = await api<Model>(page, '/reports/profit-loss?from=2026-01-01&to=2026-12-31&groupBy=project');
  expect(r.status).toBe(200);
  const dims = r.json.columns.filter((c) => c.key.startsWith('dim')).map((c) => c.key);
  expect(dims.length).toBeGreaterThanOrEqual(3);
  const sat = (s: string) => Math.round(Number(s) * 100);
  for (const row of r.json.rows.filter((x) => x.cells.total)) expect(dims.reduce((a, k) => a + sat(row.cells[k] || '0'), 0)).toBe(sat(row.cells.total));
  expect(r.json.tieOuts.every((t) => t.diff === '0.00')).toBe(true);
  const both = await api<Model>(page, '/reports/profit-loss?from=2026-01-01&to=2026-12-31&groupBy=project&compare=previous');
  expect(both.status).toBe(422);
});

test('balance sheet ties out on both companies; comparative and DBD; the TB drills into the GL tab', async ({ page }) => {
  for (const company of ['vat', 'nonvat']) {
    await page.goto(`${FS}?tab=bs&asOf=2026-06-30&company=${company}`);
    const table = page.getByRole('table', { name: 'งบแสดงฐานะการเงิน' });
    await expect(table).toContainText('หนี้สินและส่วนของเจ้าของ');
    await expect(page.getByText('ยอดกระทบตรงกัน').first()).toBeVisible();
    await expect(page.getByRole('status', { name: 'ยอดกระทบไม่ตรงกัน' })).toHaveCount(0);
    for (const asOf of ['2026-06-30', '2026-12-31', '2025-12-31']) {
      const r = await api<Model>(page, `/reports/balance-sheet?asOf=${asOf}`);
      expect([asOf, r.json.tieOuts[0].diff]).toEqual([asOf, '0.00']);
    }
  }
  await shot(page, 'bs-desktop');
  await page.goto(`${FS}?tab=bs&asOf=2026-09-30&compare=lastYear`);
  await expect(page.getByRole('table', { name: 'งบแสดงฐานะการเงิน' }).getByRole('columnheader', { name: 'ผลต่าง' })).toBeVisible();
  await shot(page, 'bs-compare');
  await page.goto(`${FS}?tab=bs&asOf=2026-09-30&format=dbd`);
  await expect(page.getByRole('table', { name: 'งบแสดงฐานะการเงิน' })).toContainText('เงินสดและรายการเทียบเท่าเงินสด');
  await shot(page, 'bs-dbd');
  await page.setViewportSize({ width: 390, height: 844 });
  await shot(page, 'bs-390');
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${FS}?tab=tb&asOf=2026-09-30`);
  await page.getByRole('table', { name: 'งบทดลอง' }).getByRole('link').first().click();
  await expect(page).toHaveURL(/tab=gl&account=\d+&to=2026-09-30/);
  await expect(page.getByRole('table', { name: 'บัญชีแยกประเภท' })).toBeVisible();
});

test('general ledger: the account is required; unknown account and company isolation answer 404; tie-out to the trial balance', async ({ page }) => {
  await page.goto(`${FS}?tab=gl`);
  await expect(page.getByText('เลือกตัวเลือกที่จำเป็นให้ครบ')).toBeVisible();
  await shot(page, 'gl-needs-account');
  await page.goto(`${FS}?tab=gl&account=1130&from=2026-01-01&to=2026-12-31`);
  await expect(page.getByRole('table', { name: 'บัญชีแยกประเภท' })).toContainText('ยอดยกไป');
  await expect(page.getByText('ยอดกระทบตรงกัน').first()).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await shot(page, 'gl-390');
  expect((await api<unknown>(page, '/reports/general-ledger')).status).toBe(422);
  expect((await api<unknown>(page, '/reports/general-ledger?account=9999')).status).toBe(404);
  expect((await api<unknown>(page, '/reports/general-ledger?account=1130&party=nc-01')).status).toBe(404); // a customer of the other company
});
