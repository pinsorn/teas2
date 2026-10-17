import { expect, test, type Page } from '@playwright/test';
import { axeClean } from './helpers/axe';
import { fixtureId } from './helpers/fixtures';
import { screenContract } from './helpers/screen-contract';

const BASE = '/accounting/period-close';
const shot = async (page: Page, name: string) => { if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/${name}.png`, fullPage: true }); };

// period close is the accountant's (ledger.read to read, ledger.period.close / reopen to act): the operator is forbidden
screenContract({ name: 'period close', path: BASE, heading: 'ปิดงวดและปิดปี', company: 'both', states: ['loading', 'error', 'forbidden'], forbiddenRole: 'operator' });

test.beforeEach(async ({ page }) => { await page.goto('/'); await page.evaluate(() => localStorage.clear()); await page.reload(); });

const api = <T,>(page: Page, path: string) => page.evaluate(async (p) => (await fetch(`/bff/v1${p}`)).json(), path) as Promise<T>;
const post = (page: Page, path: string, body: unknown) => page.evaluate(async ([p, b]) => {
  const r = await fetch(`/bff/v1${p as string}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
  return { status: r.status, json: await r.json().catch(() => undefined) } as { status: number; json: { code?: string; title?: string; id?: string } };
}, [path, body] as const);
const jvBody = (date: string) => ({ header: { documentDate: date }, lines: [
  { id: 'l1', description: 'ค่าใช้จ่าย', qty: '1', unit: '', unitPrice: '0.00', taxCode: 'EX', accountCode: '5110', debit: '10.00', credit: '0.00' },
  { id: 'l2', description: 'ค้างจ่าย', qty: '1', unit: '', unitPrice: '0.00', taxCode: 'EX', accountCode: '2120', debit: '0.00', credit: '10.00' }] });
type Tb = { rows: { cells: { code: string; debit: string; credit: string } }[] };
const tbRow = async (page: Page, code: string) => (await api<Tb>(page, '/reports/trial-balance?asOf=2025-12-31')).rows.find((r) => r.cells.code === code)?.cells;

test('close 2026-07 with a warning acknowledged, 2026-08, then 2026-09 is refused with a link to depreciation; reopen needs a reason', async ({ page }) => {
  await page.goto('/');
  await fixtureId(page, 'tiDraft'); // the mock worker is up
  const draft = await post(page, '/docs/JV', jvBody('2026-07-10')); // an unissued voucher dated in July: a warning
  expect(draft.status).toBe(201);
  await page.goto(BASE);
  await expect(page.getByRole('heading', { level: 1, name: 'ปิดงวดและปิดปี' })).toBeVisible();
  await expect(page.getByTestId('year-select')).toHaveValue('2026');
  await expect(page.getByTestId('status-2026-06')).toHaveText('ปิดแล้ว');
  await expect(page.getByTestId('status-2026-07')).toHaveText('เปิดอยู่');
  const list = page.getByTestId('checklist');
  await expect(list.getByRole('heading', { name: /ก\.ค\. 2569/ })).toBeVisible();
  await expect(page.getByTestId('count-drafts_in_month')).toHaveText('1 รายการ');
  await expect(page.getByTestId('count-depreciation_not_run')).toHaveText('0 รายการ'); // July was depreciated
  await shot(page, 'close-july-warning');
  await axeClean(page);
  // without the tick the server refuses and says why; nothing closes
  await page.getByRole('button', { name: 'ปิดงวด ก.ค. 2569' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'ต้องรับทราบข้อควรระวัง' })).toBeVisible();
  await expect(page.getByTestId('status-2026-07')).toHaveText('เปิดอยู่');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'ปิดงวด ก.ค. 2569' }).click();
  await expect(page.getByTestId('status-2026-07')).toHaveText('ปิดแล้ว');
  // a closed month shows what was accepted, frozen
  await page.getByRole('button', { name: 'ดู ก.ค. 2569' }).click();
  await expect(page.getByTestId('count-drafts_in_month')).toHaveText('1 รายการ');
  // August has nothing open: closes with one click
  await page.getByRole('button', { name: 'ตรวจสอบและปิด ส.ค. 2569' }).click();
  await page.getByRole('button', { name: 'ปิดงวด ส.ค. 2569' }).click();
  await expect(page.getByTestId('status-2026-08')).toHaveText('ปิดแล้ว');
  // September has an asset nobody depreciated: blocking, refused, the exit is a link
  await expect(page.getByTestId('count-depreciation_not_run')).toHaveText('1 รายการ');
  await page.getByRole('button', { name: 'ปิดงวด ก.ย. 2569' }).click();
  const refusal = page.getByRole('alert').filter({ hasText: 'ปิดงวดบัญชี ก.ย. 2569 ไม่ได้' });
  await expect(refusal).toBeVisible();
  await expect(page.getByTestId('status-2026-09')).toHaveText('เปิดอยู่');
  await shot(page, 'close-sept-blocked');
  await page.getByTestId('check-depreciation_not_run').getByRole('link', { name: 'ไปแก้ไข' }).click();
  await expect(page).toHaveURL(/\/accounting\/depreciation-runs\/new/);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  // reopen: only the latest closed month, with a reason
  await page.goto(BASE);
  await expect(page.getByTestId('status-2026-08')).toHaveText('ปิดแล้ว');
  await expect(page.getByRole('button', { name: /^เปิด .* อีกครั้ง$/ })).toHaveCount(1);
  await page.getByRole('button', { name: 'เปิด ส.ค. 2569 อีกครั้ง' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('button', { name: 'เปิดคืน' })).toBeDisabled();
  await dialog.getByLabel('เหตุผลที่เปิดคืน').fill('ลืมบันทึกค่าใช้จ่าย');
  await dialog.getByRole('button', { name: 'เปิดคืน' }).click();
  await expect(page.getByTestId('status-2026-08')).toHaveText('เปิดอยู่');
  await expect(page.getByTestId('period-2026-08')).toContainText('ลืมบันทึกค่าใช้จ่าย');
  await shot(page, 'close-reopen-history');
});

test('year-end close of 2025 sweeps revenue into retained earnings; the year is then final; reopening restores the figures', async ({ page }) => {
  await page.goto('/');
  await fixtureId(page, 'tiDraft'); // the mock worker is up
  const before = await tbRow(page, '4100');
  expect(before?.credit).toBe('1247575.00');
  await page.goto(BASE);
  await page.getByTestId('year-select').selectOption('2025');
  await expect(page.getByTestId('status-2025-12')).toHaveText('ปิดแล้ว');
  await page.getByRole('button', { name: 'ปิดบัญชีสิ้นปี 2568' }).click();
  await expect(page.getByTestId('year-status')).toContainText('ปิดบัญชีสิ้นปีแล้ว');
  const yc = page.getByTestId('year-close');
  await expect(yc).toContainText('กำไรสุทธิของปี 1,247,575.00 บาท');
  await expect(yc.getByRole('row', { name: /3200/ })).toContainText('1,247,575.00');
  await expect(yc.getByRole('row', { name: /4100/ })).toContainText('1,247,575.00');
  await shot(page, 'year-closed');
  await axeClean(page);
  // revenue is 0 for the year; nothing can be posted into it any more; its months do not reopen by themselves
  expect(await tbRow(page, '4100')).toMatchObject({ debit: '0.00', credit: '0.00' });
  const jv = await post(page, '/docs/JV', jvBody('2025-05-10'));
  const issue = await post(page, `/docs/JV/${jv.json.id}/issue`, { version: 1 });
  expect(issue.status).toBe(422);
  expect(issue.json.code).toBe('period.year_closed');
  const reopenMonth = await post(page, '/periods/2025-12/reopen', { reason: 'x' });
  expect(reopenMonth.json.code).toBe('period.year_closed');
  // reopen the year with a reason: the closing entry is reversed and the figures are back to the cent
  await page.getByRole('button', { name: 'เปิดปีบัญชี 2568 อีกครั้ง' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('เหตุผลที่เปิดคืน').fill('ผู้สอบบัญชีขอปรับปรุง');
  await dialog.getByRole('button', { name: 'เปิดคืน' }).click();
  await expect(page.getByTestId('year-close')).toContainText('ผู้สอบบัญชีขอปรับปรุง');
  await expect(page.getByRole('button', { name: 'ปิดบัญชีสิ้นปี 2568' })).toBeEnabled();
  expect(await tbRow(page, '4100')).toEqual(before);
});

test('the screen fits a phone: no horizontal page scroll', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(BASE);
  await expect(page.getByRole('heading', { level: 1, name: 'ปิดงวดและปิดปี' })).toBeVisible();
  await expect(page.getByTestId('checklist')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await shot(page, 'close-mobile');
});
