import { expect, test, type Page } from '@playwright/test';
import { fixtureId } from './helpers/fixtures';
import { screenContract } from './helpers/screen-contract';

screenContract({ name: 'IV list', path: '/sales/invoices', heading: 'ใบแจ้งหนี้', company: 'nonvat', states: ['empty', 'loading', 'error', 'forbidden'], forbiddenRole: 'admin', roles: ['operator', 'accountant'] });
screenContract({ name: 'IV view', path: async (p) => `/sales/invoices/${await fixtureId(p, 'ivPartly')}`, heading: /IV-\d{6}-\d{4}/, company: 'nonvat', states: ['loading', 'error', 'forbidden', 'locked'] });
screenContract({ name: 'BL list', path: '/sales/billing-statements', heading: 'ใบวางบิล', company: 'both', states: ['empty', 'loading', 'error', 'forbidden'], forbiddenRole: 'admin', roles: ['operator', 'accountant'] });
screenContract({ name: 'BL view', path: async (p) => `/sales/billing-statements/${await fixtureId(p, 'blVat')}`, heading: /BL-\d{6}-\d{4}/, company: 'vat', otherCompany: 'not-found', states: ['loading', 'error', 'forbidden'] });

const asNonVat = async (page: Page) => { await page.goto('/?company=nonvat'); };
const api = (page: Page, path: string) => page.evaluate(async (p) => (await fetch(`/bff/v1${p}`)).json(), path);

test('a VAT company opening the invoices list is told to use tax invoices', async ({ page }) => {
  await page.goto('/sales/invoices?company=vat');
  await expect(page.locator('[data-screen-state="not-available"]').first()).toContainText('บริษัทที่จดทะเบียน VAT ใช้ใบกำกับภาษีแทน');
});

test('IV partly received: the balance is the server\'s, revising below the received amount is refused with the exit, above it posts again', async ({ page }) => {
  await asNonVat(page); const id = await fixtureId(page, 'ivPartly');
  await page.goto(`/sales/invoices/${id}`);
  await expect(page.getByText('฿5,000.00')).toBeVisible(); // 8,000.00 total - 3,000.00 received
  await expect(page.getByRole('button', { name: 'ยกเลิกเอกสาร' })).toBeDisabled(); // cancel is blocked while settled
  await page.getByRole('link', { name: 'แก้ไข' }).click();
  const price = page.locator('[data-cell="0:unitPrice"]');
  await expect(page.getByRole('region', { name: 'ยังขาดอะไร' })).toHaveText(/ครบแล้ว/);
  await price.fill('1000.00'); // 2 x 1,000.00 = 2,000.00 < 3,000.00 received
  await expect(page.getByRole('region', { name: 'ยังขาดอะไร' })).toHaveText(/ครบแล้ว/);
  await page.getByRole('button', { name: 'บันทึกการแก้ไข' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'ยกเลิกหรือถอนการรับชำระก่อน' })).toBeVisible();
  await price.fill('5000.00'); // 10,000.00
  await expect(page.getByRole('region', { name: 'ยังขาดอะไร' })).toHaveText(/ครบแล้ว/);
  await page.getByRole('button', { name: 'บันทึกการแก้ไข' }).click();
  await page.getByRole('alertdialog', { name: /แผนการแก้ไข/ }).getByRole('button', { name: 'ยืนยันทั้งหมด' }).click();
  await expect(page.getByText('฿7,000.00')).toBeVisible(); // 10,000.00 - 3,000.00
  await page.getByRole('tab', { name: 'ผลต่อบัญชี' }).click();
  await expect(page.getByText('กลับรายการ').first()).toBeVisible();
  const ledger = (await api(page, `/docs/IV/${id}/ledger`)) as { entries: { kind: string; lines: { accountCode: string; debit: string; credit: string }[] }[] };
  expect(ledger.entries.map((e) => e.kind)).toEqual(['original', 'reversal', 'correction']);
  expect(ledger.entries[2].lines.map((l) => [l.accountCode, l.debit, l.credit])).toEqual([['1130', '10000.00', '0.00'], ['4100', '0.00', '10000.00']]); // no 2151
});

test('a non-VAT paper carries no VAT row even for a line coded S7 (I1)', async ({ page }) => {
  await asNonVat(page); await fixtureId(page, 'ivDraft'); // waits for the mock worker
  const id = await page.evaluate(async () => {
    const r = await (await fetch('/bff/v1/docs/IV?limit=100')).json();
    for (const i of r.items) { const d = await (await fetch(`/bff/v1/docs/IV/${i.id}`)).json(); if (d.status === 'issued' && d.lines[0]?.taxCode === 'S7') return i.id as string; }
    return '';
  });
  expect(id).not.toBe('');
  await page.goto(`/print/IV/${id}`);
  await page.waitForSelector('[data-paper-ready="true"]');
  await expect(page.locator('.paper-root')).toContainText('ใบแจ้งหนี้');
  await expect(page.locator('.paper-root')).not.toContainText('ภาษีมูลค่าเพิ่ม');
  await expect(page.locator('.paper-root')).toContainText('2,500.00');
});

test('billing statement: pick the customer, tick two invoices, the total is the server\'s, issue; the chain shows what it bills', async ({ page }) => {
  await asNonVat(page);
  await page.goto('/sales/billing-statements/new');
  await page.getByRole('combobox', { name: 'ลูกค้า' }).fill('ครัวริมคลอง');
  await page.keyboard.press('Enter');
  const group = page.getByRole('region', { name: 'เอกสารที่วางบิล' });
  const boxes = group.getByRole('checkbox');
  await expect(boxes).toHaveCount(2); // only this customer's open invoices (iv-1, iv-4)
  await boxes.nth(0).check(); await boxes.nth(1).check();
  await expect(group.getByRole('status')).toContainText('7,800.00');
  await expect(page.getByRole('region', { name: 'ยังขาดอะไร' })).toHaveText(/ครบแล้ว/);
  await page.keyboard.press('Control+Enter');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/sales\/billing-statements\/[^/]+$/);
  await expect(page.getByTestId('doc-number')).toHaveText(/^BL-\d{6}-\d{4}$/);
  await expect(page.getByText('฿7,800.00').first()).toBeVisible();
  await page.getByRole('tab', { name: 'เอกสารที่เกี่ยวข้อง' }).click();
  await expect(page.getByRole('region', { name: 'เอกสารที่เกี่ยวข้อง' }).getByText('วางบิล').first()).toBeVisible();
  await page.getByRole('tab', { name: 'ผลต่อบัญชี' }).click();
  await expect(page.getByRole('tabpanel')).not.toContainText('1130'); // a billing statement posts nothing
});

test('billing statement: cancelling it releases the grouped documents; the receive action opens the receipt with fromBl', async ({ page }) => {
  await asNonVat(page); const id = await fixtureId(page, 'blNonVat');
  await page.goto(`/sales/billing-statements/${id}`);
  await expect(page.getByRole('link', { name: 'รับชำระ' })).toHaveAttribute('href', `/sales/receipts/new?fromBl=${id}`);
  await page.getByRole('button', { name: 'ยกเลิกเอกสาร' }).click();
  const dlg = page.getByRole('alertdialog');
  await dlg.getByRole('combobox').click();
  await page.getByRole('option').first().click();
  await dlg.getByRole('button', { name: 'ยืนยันยกเลิก' }).click();
  await expect(page.locator('[data-status="cancelled"]').first()).toBeVisible();
  const chain = (await api(page, `/docs/BL/${id}/chain`)) as { edges: { from: string; kind: string; active: boolean }[] };
  expect(chain.edges.filter((e) => e.from === id && e.kind === 'groups').map((e) => e.active)).toEqual([false, false]);
  await expect(page.getByRole('link', { name: 'รับชำระ' })).toHaveCount(0); // nothing to collect on a cancelled statement
});

test('IV → billing statement: convert takes the whole invoice into a BL draft in the editor, which lists it ticked', async ({ page }) => {
  await asNonVat(page); const id = await fixtureId(page, 'ivIssuedUnpaid');
  await page.goto(`/sales/invoices/${id}`);
  await page.getByRole('button', { name: 'แปลงเป็น…' }).click();
  const dlg = page.getByRole('dialog', { name: /แปลงใบแจ้งหนี้/ });
  await expect(dlg.getByLabel('เอกสารปลายทาง').locator('option')).toHaveText(['ใบวางบิล']);
  await dlg.getByRole('button', { name: 'สร้างใบวางบิล' }).click();
  await expect(page).toHaveURL(/\/sales\/billing-statements\/[^/]+\/edit$/);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('ใบวางบิล');
  await expect(page.getByRole('region', { name: 'เอกสารที่วางบิล' }).getByRole('checkbox', { checked: true })).toHaveCount(1);
});

test('billing statements of a VAT company group tax invoices (seeded fixture)', async ({ page }) => {
  await page.goto('/'); const id = await fixtureId(page, 'blVat');
  await page.goto(`/sales/billing-statements/${id}`);
  await expect(page.getByTestId('doc-number')).toHaveText(/^BL-\d{6}-\d{4}$/);
  await page.goto(`/print/BL/${id}`);
  await page.waitForSelector('[data-paper-ready="true"]');
  await expect(page.locator('.paper-root')).toContainText('ใบวางบิล');
  await expect(page.locator('.paper-root')).toContainText('ใบกำกับภาษี TI-');
});
