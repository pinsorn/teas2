import { expect, test, type Page } from '@playwright/test';
import { fixtureId } from './helpers/fixtures';
import { screenContract } from './helpers/screen-contract';

screenContract({ name: 'CN list', path: '/sales/credit-notes', heading: 'ใบลดหนี้', company: 'vat', states: ['empty', 'loading', 'error', 'forbidden'], forbiddenRole: 'admin', roles: ['operator', 'accountant'] });
screenContract({ name: 'DN list', path: '/sales/debit-notes', heading: 'ใบเพิ่มหนี้', company: 'vat', states: ['empty', 'loading', 'error', 'forbidden'], forbiddenRole: 'admin', roles: ['operator', 'accountant'] });
screenContract({ name: 'CN view', path: async (p) => `/sales/credit-notes/${await fixtureId(p, 'cnIssued')}`, heading: /CN-\d{6}-\d{4}/, company: 'vat', states: ['loading', 'error', 'forbidden'], roles: ['operator', 'accountant'] });
screenContract({ name: 'DN view', path: async (p) => `/sales/debit-notes/${await fixtureId(p, 'dnIssued')}`, heading: /DN-\d{6}-\d{4}/, company: 'vat', states: ['loading', 'error', 'forbidden'] });
screenContract({ name: 'CN new (pick the invoice)', path: '/sales/credit-notes/new', heading: /เลือกใบกำกับภาษีที่จะลดหนี้/, company: 'vat', states: ['loading', 'error'] });

const api = <T,>(page: Page, path: string) => page.evaluate(async (p) => (await fetch(`/bff/v1${p}`)).json(), path) as Promise<T>;
type DocJson = { number: string; status: string; outstanding?: string; totals: { net: string; vat: string; total: string }; header: { refDocId?: string; reasonCode?: string; reference?: string };
  lines: { sourceLineId?: string; qty: string }[] };
const doc = (page: Page, type: string, id: string) => api<DocJson>(page, `/docs/${type}/${id}`);
const sat = (m: string) => Math.round(Number(m) * 100);
const qty = (page: Page, n: number) => page.getByRole('textbox', { name: `จำนวน ${n}`, exact: true });

test('TI view -> ออกใบลดหนี้ -> lines prefilled from the invoice -> reduce line 1 -> reason RETURN -> issue: the TI outstanding drops by the CN total', async ({ page }) => {
  await page.goto('/');
  const tiId = await fixtureId(page, 'tiIssuedUnpaid');
  const before = (await doc(page, 'TI', tiId)).outstanding!;
  await page.goto(`/sales/tax-invoices/${tiId}`);
  await expect(page.getByTestId('doc-number')).toHaveText(/^TI-/);
  await page.getByRole('link', { name: 'ออกใบลดหนี้' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'สร้างใบลดหนี้' })).toBeVisible();
  await expect(qty(page, 1)).toHaveValue('2'); // the invoice's line, as the server has it
  await expect(page.getByLabel('ใบกำกับภาษีที่อ้างอิง')).toHaveValue(/^TI-\d{6}-\d{4} · /);
  await expect(page.getByText('ลูกค้าตามใบกำกับภาษีที่อ้างอิง')).toBeVisible();
  await expect(page.getByRole('region', { name: 'ยังขาดอะไร' })).toContainText('เหตุผล'); // a reason is needed
  await qty(page, 1).fill('1');
  await page.getByLabel('เหตุผล', { exact: true }).selectOption('RETURN');
  await expect(page.getByRole('region', { name: 'ยังขาดอะไร' })).toHaveText(/ครบแล้ว/);
  await page.keyboard.press('Control+Enter');
  await page.getByRole('alertdialog').getByRole('button', { name: /^ออกใบลดหนี้$/ }).click();
  await expect(page.getByTestId('doc-number')).toHaveText(/^CN-\d{6}-\d{4}$/);
  const cn = await doc(page, 'CN', page.url().split('/').pop()!);
  expect(cn.totals).toMatchObject({ net: '85000.00', vat: '5950.00', total: '90950.00' }); // one of the two units, VAT 7%
  expect(cn.header).toMatchObject({ refDocId: tiId, reasonCode: 'RETURN' });
  expect(cn.lines[0].sourceLineId).toBeTruthy();
  const after = (await doc(page, 'TI', tiId)).outstanding!;
  expect(sat(after)).toBe(sat(before) - sat(cn.totals.total)); // the money, to the satang, from the TI's own header
  await page.goto(`/sales/tax-invoices/${tiId}`);
  await expect(page.getByText('฿' + Number(after).toLocaleString('en-US', { minimumFractionDigits: 2 })).first()).toBeVisible();
});

test('a credit above what is left of the line is refused in the editor and by the server', async ({ page }) => {
  await page.goto('/');
  const tiId = await fixtureId(page, 'tiIssuedUnpaid');
  await page.goto(`/sales/credit-notes/new?adjust=${tiId}`);
  await expect(qty(page, 1)).toHaveValue('2');
  await qty(page, 1).fill('3'); // the invoice sold 2
  await page.getByLabel('เหตุผล', { exact: true }).selectOption('RETURN');
  await expect(page.getByRole('region', { name: 'ยังขาดอะไร' })).toContainText('ลดหนี้เกินยอดเดิม');
  await expect(page.getByRole('button', { name: 'บันทึกและออกใบลดหนี้' })).toBeDisabled();
  await qty(page, 1).fill('2');
  await expect(page.getByRole('region', { name: 'ยังขาดอะไร' })).toHaveText(/ครบแล้ว/);
  await expect(page.getByRole('button', { name: 'บันทึกและออกใบลดหนี้' })).toBeEnabled();
});

test('reason "other" needs a text; the paper prints the Thai wording and the ม.86/10 values, never the code', async ({ page }) => {
  await page.goto('/');
  const tiId = await fixtureId(page, 'tiIssuedUnpaid');
  await page.goto(`/sales/credit-notes/new?adjust=${tiId}`);
  await qty(page, 1).fill('1');
  await page.getByLabel('เหตุผล', { exact: true }).selectOption('OTHER');
  await expect(page.getByRole('region', { name: 'ยังขาดอะไร' })).toContainText('ระบุเหตุผลเพิ่มเติม');
  await page.getByLabel('ระบุเหตุผล', { exact: true }).fill('ลูกค้าต่อรองราคา');
  await expect(page.getByRole('region', { name: 'ยังขาดอะไร' })).toHaveText(/ครบแล้ว/);
  await page.keyboard.press('Control+Enter');
  await page.getByRole('alertdialog').getByRole('button', { name: /^ออกใบลดหนี้$/ }).click();
  await expect(page.getByTestId('doc-number')).toHaveText(/^CN-\d{6}-\d{4}$/);
  const paper = page.locator('.paper-root');
  await expect(paper).toContainText('ลูกค้าต่อรองราคา');
  await expect(paper).toContainText('มูลค่าตามใบกำกับภาษีเดิม');
  await expect(paper).toContainText('มูลค่าที่ถูกต้อง');
  await expect(paper).toContainText('ผลต่าง');
  await expect(paper).not.toContainText('OTHER');
  await page.getByRole('tab', { name: 'เอกสารที่เกี่ยวข้อง' }).click();
  await expect(page.getByRole('link', { name: /TI-\d{6}-\d{4}/ })).toBeVisible();
});

test('seeded notes: the return CN prints a Thai reason; the fully credited TI is still issued with outstanding 0.00', async ({ page }) => {
  await page.goto('/');
  const cnId = await fixtureId(page, 'cnIssued'); const zero = await fixtureId(page, 'tiCreditedToZero');
  await page.goto(`/print/CN/${cnId}`);
  await page.waitForSelector('[data-paper-ready="true"]');
  await expect(page.locator('.paper-root')).toContainText('รับคืนสินค้า / สินค้าชำรุด');
  await expect(page.locator('.paper-root')).toContainText('ใบลดหนี้');
  await expect(page.locator('.paper-root')).not.toContainText('RETURN');
  const t = await doc(page, 'TI', zero);
  expect([t.status, t.outstanding]).toEqual(['issued', '0.00']);
  await page.goto(`/sales/tax-invoices/${zero}`);
  await expect(page.locator('[data-status="issued"]').first()).toHaveText('ออกแล้ว');
});

test('an operator reads credit notes but cannot make one: the button is disabled and names the permission', async ({ page }) => {
  await page.goto('/');
  const tiId = await fixtureId(page, 'tiIssuedUnpaid');
  await page.goto(`/sales/tax-invoices/${tiId}?role=operator`);
  await expect(page.getByTestId('doc-number')).toHaveText(/^TI-/);
  const button = page.getByRole('button', { name: 'ออกใบลดหนี้' });
  await expect(button).toBeDisabled();
  await expect(button).toHaveAccessibleDescription(/doc\.CN\.create/);
  await expect(page.getByRole('link', { name: 'ออกใบเพิ่มหนี้' })).toHaveCount(0);
});

test('a lower-total correction of a TI is a credit note only: confirming lands on the credit note', async ({ page }) => {
  await page.goto('/');
  const tiId = await fixtureId(page, 'tiIssuedUnpaid');
  await page.goto(`/sales/tax-invoices/${tiId}`);
  await page.getByRole('link', { name: 'แก้ไข' }).click();
  await page.getByRole('textbox', { name: 'ราคาต่อหน่วย 1' }).fill('1.00');
  await page.getByRole('button', { name: 'บันทึกการแก้ไข' }).click();
  const dialog = page.getByRole('alertdialog', { name: /แผนการแก้ไข/ });
  await expect(dialog).toContainText('ใบลดหนี้');
  await dialog.getByRole('button', { name: 'ยืนยันทั้งหมด' }).click();
  await expect(page).toHaveURL(/\/sales\/credit-notes\/[^/]+$/); // the note exists as a screen now (M4)
  await expect(page.getByTestId('doc-number')).toHaveText(/^CN-\d{6}-\d{4}$/);
  const cn = await doc(page, 'CN', page.url().split('/').pop()!);
  const ti = await doc(page, 'TI', tiId);
  expect(cn.header.refDocId).toBe(tiId);
  expect(sat(ti.outstanding!)).toBe(sat('181900.00') - sat(cn.totals.total));
  expect(ti.outstanding).toBe('2.14'); // 2 x 1.00 + VAT is what the invoice is worth now
});

test('debit note from the invoice: no cap, the TI outstanding rises by the DN total', async ({ page }) => {
  await page.goto('/');
  const tiId = await fixtureId(page, 'tiIssuedUnpaid');
  const before = (await doc(page, 'TI', tiId)).outstanding!;
  await page.goto(`/sales/tax-invoices/${tiId}`);
  await page.getByRole('link', { name: 'ออกใบเพิ่มหนี้' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'สร้างใบเพิ่มหนี้' })).toBeVisible();
  await qty(page, 1).fill('5'); // more than the invoice had: a debit note is not capped
  await page.getByLabel('เหตุผล', { exact: true }).selectOption('QTY_EXCESS');
  await expect(page.getByRole('region', { name: 'ยังขาดอะไร' })).toHaveText(/ครบแล้ว/);
  await page.keyboard.press('Control+Enter');
  await page.getByRole('alertdialog').getByRole('button', { name: /^ออกใบเพิ่มหนี้$/ }).click();
  await expect(page.getByTestId('doc-number')).toHaveText(/^DN-\d{6}-\d{4}$/);
  const dn = await doc(page, 'DN', page.url().split('/').pop()!);
  expect(sat(dn.totals.total)).toBeGreaterThan(0);
  expect(sat((await doc(page, 'TI', tiId)).outstanding!)).toBe(sat(before) + sat(dn.totals.total));
});
