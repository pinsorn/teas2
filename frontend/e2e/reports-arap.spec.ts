import { expect, test, type Page } from '@playwright/test';
import { axeClean } from './helpers/axe';
import { screenContract } from './helpers/screen-contract';

const AP = '/reports/receivables-payables', SP = '/reports/sales-purchases';
const shot = async (page: Page, name: string) => { if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/${name}.png`, fullPage: true }); };
const api = <T,>(page: Page, path: string) => page.evaluate(async (p) => { const r = await fetch(`/bff/v1${p}`); return { status: r.status, json: await r.json().catch(() => undefined) }; }, path) as Promise<{ status: number; json: T }>;
type Model = { rows: { kind: string; cells: Record<string, string> }[]; columns: { key: string }[]; tieOuts: { diff: string }[] };
const num = (t: string) => Number(t.replace(/,/g, ''));

// report.arap.read is the accountant's and the owner's: the operator is forbidden on every tab (the asset register tab keeps report.read, which the operator lacks too)
const gate = { company: 'both' as const, states: ['empty', 'loading', 'error', 'forbidden'] as ('empty' | 'loading' | 'error' | 'forbidden')[], forbiddenRole: 'operator' as const };
screenContract({ name: 'receivables aging', path: `${AP}?tab=ar`, heading: 'ลูกหนี้และเจ้าหนี้', ...gate });
screenContract({ name: 'payables aging', path: `${AP}?tab=ap`, heading: 'ลูกหนี้และเจ้าหนี้', ...gate });
screenContract({ name: 'customer statement', path: `${AP}?tab=cs&party=pc-10`, heading: 'ลูกหนี้และเจ้าหนี้', ...gate });
screenContract({ name: 'vendor ledger', path: `${AP}?tab=vl&party=pv-02`, heading: 'ลูกหนี้และเจ้าหนี้', ...gate });
screenContract({ name: 'sales summary', path: `${SP}?tab=sales`, heading: 'สรุปขายและซื้อ', ...gate });
screenContract({ name: 'purchase summary', path: `${SP}?tab=purchases`, heading: 'สรุปขายและซื้อ', ...gate });
screenContract({ name: 'outstanding purchase orders', path: `${SP}?tab=po`, heading: 'สรุปขายและซื้อ', ...gate });
screenContract({ name: 'asset register tab', path: `${SP}?tab=assets`, heading: 'สรุปขายและซื้อ', ...gate });

test.afterEach(async ({ page }) => { await axeClean(page); });

test('receivables aging: five buckets, deposits apart, ties to the ledger; a party row opens its statement and the statement ends at the same figure', async ({ page }) => {
  await page.goto(`${AP}?tab=ar&asOf=2026-10-14`);
  const table = page.getByRole('table', { name: 'ลูกหนี้ค้างรับตามอายุหนี้' });
  await expect(table).toBeVisible();
  for (const h of ['ยังไม่ถึงกำหนด', '1-30 วัน', '31-60 วัน', '61-90 วัน', 'เกิน 90 วัน', 'เงินมัดจำรับล่วงหน้า (แยกต่างหาก)']) await expect(table.getByRole('columnheader', { name: h })).toBeVisible();
  await expect(page.getByText('ยอดกระทบตรงกัน').first()).toBeVisible();
  await expect(page.getByRole('status', { name: 'ยอดกระทบไม่ตรงกัน' })).toHaveCount(0);
  await shot(page, 'arap-ar-desktop');
  const m = await api<Model>(page, '/reports/ar-aging?asOf=2026-10-14');
  expect(m.status).toBe(200);
  expect(m.json.tieOuts.map((t) => t.diff)).toEqual(['0.00', '0.00', '0.00', '0.00']);
  const row = table.getByRole('row').filter({ hasText: 'C10' }).first();
  const total = (await row.getByRole('cell').nth(9).innerText()).trim(); // "รวมค้าง" of the party
  await row.getByRole('link').first().click();
  await expect(page).toHaveURL(/tab=cs&party=pc-\d+&to=2026-10-14/);
  const stmt = page.getByRole('table', { name: 'ใบแสดงรายการบัญชีลูกหนี้ (Statement)' });
  await expect(stmt).toContainText('ยอดยกไป');
  const closing = stmt.getByRole('row').filter({ hasText: 'ยอดยกไป' });
  expect(num((await closing.getByRole('cell').last().innerText()).trim())).toBe(num(total)); // the statement's closing IS the aging total of the party
  await shot(page, 'arap-cs-desktop');
});

test('the aging basis and date change the buckets; a bad basis is refused by the API', async ({ page }) => {
  await page.goto(`${AP}?tab=ar&asOf=2026-10-14&basis=document`);
  await expect(page.getByRole('table', { name: 'ลูกหนี้ค้างรับตามอายุหนี้' })).toBeVisible();
  const due = await api<Model>(page, '/reports/ar-aging?asOf=2026-10-14&basis=due'), doc = await api<Model>(page, '/reports/ar-aging?asOf=2026-10-14&basis=document');
  const b0 = (m: Model) => num(m.rows.find((r) => r.kind === 'total')!.cells.b0);
  expect(b0(due.json)).toBeGreaterThan(b0(doc.json)); // aged from the document date, less is "not yet due"
  expect((await api<Model>(page, '/reports/ar-aging?basis=x')).status).toBe(422);
  expect((await api<Model>(page, '/reports/ar-aging?asOf=2026-02-30')).status).toBe(422);
});

test('payables aging mirrors it, with prepayments apart', async ({ page }) => {
  await page.goto(`${AP}?tab=ap&asOf=2026-10-14`);
  const table = page.getByRole('table', { name: 'เจ้าหนี้ค้างจ่ายตามอายุหนี้' });
  await expect(table).toBeVisible();
  await expect(table.getByRole('columnheader', { name: 'เงินจ่ายล่วงหน้า (แยกต่างหาก)' })).toBeVisible();
  const m = await api<Model>(page, '/reports/ap-aging?asOf=2026-10-14');
  expect(m.json.tieOuts.map((t) => t.diff)).toEqual(['0.00', '0.00', '0.00', '0.00']);
  await shot(page, 'arap-ap-desktop');
});

test('customer statement: pick the customer from the list (the id goes in the URL), print and CSV', async ({ page }) => {
  await page.goto(`${AP}?tab=cs&from=2026-01-01&to=2026-10-14`);
  await expect(page.getByRole('table', { name: 'ใบแสดงรายการบัญชีลูกหนี้ (Statement)' })).toHaveCount(0); // the party is required: nothing is asked before it is chosen
  const pick = page.getByRole('combobox', { name: /ลูกค้า/ });
  await expect(pick.locator('option')).not.toHaveCount(1); // the company's customers arrived
  await pick.selectOption({ value: 'pc-10' });
  await expect(page).toHaveURL(/party=pc-\d+/);
  const stmt = page.getByRole('table', { name: 'ใบแสดงรายการบัญชีลูกหนี้ (Statement)' });
  await expect(stmt).toBeVisible();
  await expect(stmt).toContainText('ยอดยกมา');
  await expect(page.getByText('ลูกค้า: C').first()).toBeVisible();
  await shot(page, 'arap-cs-picked');
  await page.emulateMedia({ media: 'print' });
  await expect(page.getByRole('button', { name: 'พิมพ์' })).toBeHidden(); // the toolbar and the parameters do not print
  await shot(page, 'arap-cs-print');
  await page.emulateMedia({ media: 'screen' });
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'ส่งออก CSV' }).click()]);
  expect(download.suggestedFilename()).toBe('customer-statement.csv');
});

test('vendor ledger and a customer\'s id on the vendor ledger', async ({ page }) => {
  await page.goto(`${AP}?tab=vl&party=pv-02&from=2026-01-01&to=2026-10-14`);
  await expect(page.getByRole('table', { name: 'บัญชีเจ้าหนี้รายผู้ขาย' })).toBeVisible();
  await shot(page, 'arap-vl-desktop');
  const bad = await api<Model>(page, '/reports/vendor-ledger?party=pc-10');
  expect(bad.status).toBe(422);
  expect((await api<Model>(page, '/reports/customer-statement?party=nc-01')).status).toBe(404); // another company's customer
});

test('sales summary: group by customer / month; VAT equals the output register; every group total adds up', async ({ page }) => {
  await page.goto(`${SP}?tab=sales&from=2026-01-01&to=2026-10-14&groupBy=month`);
  const table = page.getByRole('table', { name: 'สรุปยอดขาย' });
  await expect(table).toBeVisible();
  await expect(table.getByRole('columnheader', { name: 'ภาษีมูลค่าเพิ่ม' })).toBeVisible();
  await expect(page.getByText('ยอดกระทบตรงกัน').first()).toBeVisible();
  await shot(page, 'sp-sales-desktop');
  for (const g of ['customer', 'item', 'month']) {
    const m = await api<Model>(page, `/reports/sales-summary?from=2026-01-01&to=2026-10-14&groupBy=${g}`);
    const sum = (k: string) => Math.round(m.json.rows.filter((r) => r.kind === 'row').reduce((n, r) => n + num(r.cells[k]) * 100, 0));
    expect(sum('total'), g).toBe(Math.round(num(m.json.rows.find((r) => r.kind === 'total')!.cells.total) * 100));
    expect(m.json.tieOuts.map((t) => t.diff), g).toEqual(['0.00', '0.00']);
  }
  expect((await api<Model>(page, '/reports/sales-summary?groupBy=colour')).status).toBe(422);
  await page.goto(`${SP}?tab=sales&company=nonvat&from=2026-01-01&to=2026-10-14`);
  await expect(page.getByRole('table', { name: 'สรุปยอดขาย' })).toBeVisible();
  await expect(page.getByRole('table', { name: 'สรุปยอดขาย' }).getByRole('columnheader', { name: 'ภาษีมูลค่าเพิ่ม' })).toHaveCount(0); // a non-VAT company has no VAT column
});

test('purchase summary: claimable input VAT apart from the VAT on the bills, tied to the input register', async ({ page }) => {
  await page.goto(`${SP}?tab=purchases&from=2026-01-01&to=2026-10-14`);
  const table = page.getByRole('table', { name: 'สรุปยอดซื้อ' });
  await expect(table.getByRole('columnheader', { name: 'ภาษีซื้อที่ขอคืนได้' })).toBeVisible();
  await expect(page.getByText('วันที่เอกสาร').first()).toBeVisible();
  await shot(page, 'sp-purchases-desktop');
  const m = await api<Model>(page, '/reports/purchase-summary?from=2026-01-01&to=2026-10-14&groupBy=vendor');
  expect(m.json.tieOuts.map((t) => t.diff)).toEqual(['0.00', '0.00']);
});

test('outstanding purchase orders: overdue only', async ({ page }) => {
  await page.goto(`${SP}?tab=po&asOf=2026-10-27`);
  const table = page.getByRole('table', { name: 'ใบสั่งซื้อค้างรับ' });
  await expect(table).toBeVisible();
  await expect(table).toContainText('เลยกำหนด');
  await shot(page, 'sp-po-desktop');
  await page.getByLabel('เฉพาะที่เลยกำหนด').check();
  await expect(table).toContainText('เลยกำหนด');
  const all = await api<Model>(page, '/reports/outstanding-po?asOf=2026-10-14&overdueOnly=true');
  expect(all.json.rows).toEqual([]);
});

test('asset register tab: the same report, tied per class account', async ({ page }) => {
  await page.goto(`${SP}?tab=assets&asOf=2026-10-14`);
  await expect(page.getByRole('table', { name: 'ทะเบียนสินทรัพย์' })).toBeVisible();
  const m = await api<Model>(page, '/reports/asset-register?asOf=2026-10-14');
  expect(m.json.tieOuts.length).toBeGreaterThanOrEqual(6); // accumulated, cost, then 1210 / 1211 / 1220 / 1221
  expect(m.json.tieOuts.every((t) => t.diff === '0.00')).toBe(true);
  await shot(page, 'sp-assets-desktop');
});

test('390 px: each tab opens, the money columns scroll inside the table, nothing overflows the page', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const [url, name] of [[`${AP}?tab=ar`, 'arap-ar-390'], [`${AP}?tab=cs&party=pc-10`, 'arap-cs-390'], [`${AP}?tab=ap`, 'arap-ap-390'], [`${AP}?tab=vl&party=pv-02`, 'arap-vl-390'], [`${SP}?tab=sales`, 'sp-sales-390'], [`${SP}?tab=purchases`, 'sp-purchases-390'], [`${SP}?tab=po&asOf=2026-10-27`, 'sp-po-390'], [`${SP}?tab=assets`, 'sp-assets-390']] as const) {
    await page.goto(url);
    await expect(page.getByRole('table').first()).toBeVisible();
    await shot(page, name);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), url).toBeLessThanOrEqual(1);
  }
});
