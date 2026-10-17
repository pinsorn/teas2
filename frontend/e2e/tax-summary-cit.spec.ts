import { expect, test, type Page } from '@playwright/test';
import { axeClean } from './helpers/axe';
import { fixtureId } from './helpers/fixtures';
import { screenContract } from './helpers/screen-contract';

const shot = async (page: Page, name: string) => { if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/${name}.png`, fullPage: true }); };

// TX3a: the corporate income tax page is the accountant's (tax.read): the operator is forbidden; a filing page has no lock state (a finalized year shows the read-only "ยื่นแล้ว" banner)
screenContract({ name: 'corporate income tax', path: '/tax/cit?period=2025', heading: 'ภาษีเงินได้นิติบุคคล (ภ.ง.ด.50 และ 51)', company: 'both', states: ['empty', 'loading', 'error', 'forbidden'], forbiddenRole: 'operator' });

test.beforeEach(async ({ page }) => { await page.goto('/'); await page.evaluate(() => localStorage.clear()); await page.reload(); });

const call = (page: Page, method: string, path: string, body?: unknown) => page.evaluate(async ([m, p, b]) => {
  const r = await fetch(`/bff/v1${p as string}`, { method: m as string, headers: { 'content-type': 'application/json' }, ...(b ? { body: JSON.stringify(b) } : {}) });
  return { status: r.status, json: await r.json().catch(() => undefined) } as { status: number; json: { code?: string; title?: string } };
}, [method, path, body] as const);

test('FY2025: blocked until the year-end close, then confirmed; the figures, the adjustment with its reason, the amber tie-out, and the year can no longer be reopened', async ({ page }) => {
  await page.goto('/');
  await fixtureId(page, 'tiDraft'); // the mock worker is up
  await page.goto('/tax/cit?period=2025');
  await expect(page.getByRole('heading', { level: 1, name: 'ภาษีเงินได้นิติบุคคล (ภ.ง.ด.50 และ 51)' })).toBeVisible();
  await expect(page.getByTestId('cit-sme')).toHaveText('เข้าเกณฑ์ SME');
  await expect(page.getByTestId('box-2.9')).toContainText('1,247,575.00');
  await expect(page.getByTestId('box-2.21')).toContainText('1,017,575.00');
  await expect(page.getByTestId('box-tax')).toContainText('107,636.25');
  await expect(page.getByRole('status', { name: 'ยอดกระทบไม่ตรงกัน' })).toContainText('ภาษีเงินได้ในบัญชี'); // ruling 8: amber, not a blocker
  await expect(page.getByTestId('blocker-year_not_closed')).toBeVisible();
  await expect(page.getByRole('button', { name: /ยืนยันยื่นแบบ/ })).toBeDisabled();
  await shot(page, 'cit-blocked');
  // an adjustment needs a reason
  await page.getByRole('button', { name: 'เพิ่มรายการปรับปรุง' }).click();
  await page.getByLabel('บรรทัด', { exact: true }).selectOption('10');
  await page.getByLabel('จำนวนเงิน (บาท)', { exact: true }).fill('1000.00');
  await page.getByRole('button', { name: 'บันทึกรายการ' }).click();
  await expect(page.getByTestId('cit-adj-form').getByRole('alert')).toContainText('เหตุผล');
  await page.getByLabel(/เหตุผล/).fill('รายได้ตามประมวลรัษฎากร');
  await page.getByRole('button', { name: 'บันทึกรายการ' }).click();
  await expect(page.getByTestId('box-2.10')).toContainText('1,000.00');
  await page.getByTestId('adj-cit-adj-2').getByRole('button', { name: 'ลบ' }).click();
  await expect(page.getByTestId('box-2.10')).toContainText('0.00');
  // the year-end close (the real command), then confirm
  expect((await call(page, 'POST', '/periods/year/2025/close')).status).toBe(200);
  await page.reload();
  await expect(page.getByTestId('blocker-year_not_closed')).toHaveCount(0);
  await page.getByRole('button', { name: /ยืนยันยื่นแบบ/ }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: /ยืนยันยื่นแบบ/ }).click();
  await expect(page.getByTestId('filed-banner')).toContainText('ยื่นแล้ว');
  await expect(page.getByTestId('cit-locked')).toBeVisible();
  await expect(page.getByTestId('filing-history').getByRole('link')).toHaveCount(1);
  await shot(page, 'cit-filed');
  await axeClean(page);
  const reopen = await call(page, 'POST', '/periods/year/2025/reopen', { reason: 'แก้ไข' });
  expect([reopen.status, reopen.json?.code]).toEqual([409, 'filing.locked']);
  expect((await call(page, 'PUT', '/cit-years/2025', { paidUpCapital: '9.00' })).json?.code).toBe('filing.locked');
});

test('ภ.ง.ด.51 of 2026: half the tax on twice the H1 profit; the estimate path replaces it; the page never scrolls sideways at 390 px', async ({ page }) => {
  await page.goto('/');
  await fixtureId(page, 'tiDraft');
  await page.goto('/tax/cit?tab=pnd51&period=2026');
  await expect(page.getByTestId('box-estimate')).toBeVisible();
  const before = await page.getByTestId('box-tax').innerText();
  await page.getByLabel('วิธีประมาณการ').selectOption('input');
  await page.getByLabel(/ประมาณการกำไรสุทธิทั้งปี/).fill('1000000.00');
  await page.getByRole('button', { name: 'บันทึกข้อมูลประจำปี' }).click();
  await expect(page.getByTestId('box-estimate')).toContainText('1,000,000.00');
  expect(await page.getByTestId('box-tax').innerText()).not.toBe(before);
  await expect(page.getByTestId('box-tax')).toContainText('52,500.00'); // 15 % of 700,000.00 = 105,000.00; half
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/tax/cit?tab=pnd51&period=2026');
  await expect(page.getByTestId('box-estimate')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await shot(page, 'cit-pnd51-mobile');
});

test('the payment dialog names each line\'s bank account and refuses a half-filled extra row', async ({ page }) => {
  await page.goto('/');
  await fixtureId(page, 'tiDraft');
  await page.goto('/tax/vat?period=2026-08');
  await page.getByRole('button', { name: 'ชำระภาษี' }).click();
  const dialog = page.getByTestId('tax-payment-dialog');
  await expect(dialog.getByTestId('no-lines').or(dialog.getByTestId('line-account').first())).toBeVisible();
  await dialog.getByLabel('จำนวนเงิน (บาท)', { exact: true }).fill('10.00');
  await expect(dialog.getByTestId('extra-half')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'ชำระภาษี' })).toBeDisabled();
});
