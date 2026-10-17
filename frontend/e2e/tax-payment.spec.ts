import { expect, test, type Page } from '@playwright/test';
import { axeClean } from './helpers/axe';
import { KBIZ_OCT_NAME, kbizCsv } from '../src/mocks/fixtures/statements/kbiz-2026-10.csv';
import { KBANK_ACCOUNT_NO, KBANK_SEP_CLOSING, withBalances } from '../src/mocks/fixtures/statements/kplus-2026-09';

const shot = async (page: Page, name: string) => { if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/${name}.png`, fullPage: true }); };

test.beforeEach(async ({ page }) => { await page.goto('/'); await page.evaluate(() => localStorage.clear()); await page.reload(); });

// TX2c: finalize the ภ.พ.30, import the statement carrying the Revenue Department debit, pay the return from that line, see it on every surface, then cancel the payment.
test('finalize a ภ.พ.30, pay it from a statement line, see it paid everywhere, cancel the payment', async ({ page }) => {
  await page.goto('/tax/vat?period=2026-09');
  await page.getByRole('button', { name: /ยืนยันยื่นแบบ/ }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: /ยืนยันยื่นแบบ/ }).click();
  await expect(page.getByTestId('filed-banner')).toBeVisible();
  const f = await page.evaluate(async () => (await (await fetch('/bff/v1/filings/PP30/2026-09')).json()) as { boxes: { code: string; amount: string }[]; payment: { status: string; due: string } });
  const due = f.payment.due;
  expect(Number(due)).toBeGreaterThan(0); // the September box 8; the seeded July / August returns also owe tax if a future seed changes this
  expect(f.payment.status).toBe('unpaid');
  const csv = kbizCsv({ accountNo: KBANK_ACCOUNT_NO, accountName: 'บริษัท ตัวอย่าง จำกัด', from: '2026-10-01', opening: KBANK_SEP_CLOSING, lines: withBalances(KBANK_SEP_CLOSING, [['2026-10-14', 'ชำระภาษี กรมสรรพากร', `-${due}`]]) });
  const status = await page.evaluate(async ([content, name]) => (await fetch('/bff/v1/finance/bank-accounts/ba-kbank/imports', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fileName: name, format: 'kbiz-csv', content }) })).status, [Buffer.from(csv, 'utf8').toString('base64'), KBIZ_OCT_NAME]);
  expect(status).toBe(201);

  await page.goto('/tax/vat?period=2026-09');
  const box = page.getByTestId('tax-payment');
  await expect(box).toContainText('ภาษีที่ต้องชำระ');
  await box.getByRole('button', { name: 'ชำระภาษี' }).click();
  const dialog = page.getByTestId('tax-payment-dialog');
  await expect(dialog.getByText('ยอดตรงกับภาษี')).toBeVisible();
  await shot(page, 'tax-pay-dialog');
  await axeClean(page);
  await dialog.getByRole('radio', { name: /ชำระภาษี กรมสรรพากร/ }).check();
  await dialog.getByRole('button', { name: 'ชำระภาษี' }).click();
  await expect(box).toContainText('ชำระแล้ว วันที่');
  await expect(page.getByTestId('history-payment-2026-09')).toContainText('ชำระแล้ว');
  await shot(page, 'tax-paid');

  // the bank page: the posted line links back to the return
  await box.getByRole('link', { name: 'เปิดรายการเดินบัญชี' }).click();
  const back = page.getByRole('link', { name: /ชำระภาษี ภ\.พ\.30/ });
  await expect(back).toBeVisible();
  await shot(page, 'tax-paid-bank-line');
  await back.click();
  await expect(page.getByTestId('tax-payment')).toContainText('ชำระแล้ว วันที่');

  // cancel: a reason is required; the return reads unpaid again and the line is unmatched
  await page.getByTestId('tax-payment').getByRole('button', { name: 'ยกเลิกการชำระ' }).click();
  const ask = page.getByRole('alertdialog');
  const go = ask.getByRole('button', { name: 'ยกเลิกการชำระ' });
  await expect(go).toBeDisabled();
  await ask.getByRole('textbox').fill('เลือกรายการผิด');
  await go.click();
  await expect(page.getByTestId('tax-payment')).toContainText('ภาษีที่ต้องชำระ');
  await expect(page.getByTestId('history-payment-2026-09')).toContainText('ยังไม่ชำระ');
  const lines = await page.evaluate(async () => (await (await fetch('/bff/v1/finance/bank-accounts/ba-kbank/lines?status=unmatched')).json()) as { items: { description: string }[] });
  expect(lines.items.map((l) => l.description)).toContain('ชำระภาษี กรมสรรพากร');
});

test('at 390px the payment box and its dialog do not overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/tax/vat?period=2026-08'); // seeded, finalized, tax to pay
  const box = page.getByTestId('tax-payment');
  await expect(box).toContainText('7,875.00');
  await box.getByRole('button', { name: 'ชำระภาษี' }).click();
  await expect(page.getByTestId('tax-payment-dialog')).toBeVisible();
  await shot(page, 'tax-pay-dialog-390');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await axeClean(page);
});
