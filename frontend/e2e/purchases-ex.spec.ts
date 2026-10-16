import { expect, test, type Page } from '@playwright/test';
import { fixtureId } from './helpers/fixtures';
import { screenContract } from './helpers/screen-contract';

screenContract({ name: 'EX list', path: '/purchases/expense-claims', heading: 'ใบเบิกค่าใช้จ่าย', company: 'both', states: ['empty', 'loading', 'error', 'forbidden'], forbiddenRole: 'admin', roles: ['operator', 'accountant'] });
screenContract({ name: 'EX view', path: async (p) => `/purchases/expense-claims/${await fixtureId(p, 'exPending')}`, heading: /รออนุมัติ|EX-\d{6}-\d{4}/, company: 'vat', otherCompany: 'not-found', states: ['loading', 'error', 'forbidden'], roles: ['operator', 'accountant'] });
screenContract({ name: 'EX new', path: '/purchases/expense-claims/new', heading: 'สร้างใบเบิกค่าใช้จ่าย', company: 'both', states: ['loading', 'error'] });

const BASE = '/purchases/expense-claims';
const api = <T,>(page: Page, path: string) => page.evaluate(async (p) => (await fetch(`/bff/v1${p}`)).json(), path) as Promise<T>;
type DocJson = { number?: string; status: string; outstanding?: string; totals: { net: string; vat: string; total: string; wht?: string; cash?: string }; party?: { id: string; name: string }; approval?: { approvedBy?: { name: string } };
  lines: { id: string; vendorInvoice?: { number: string } }[]; allocations?: { targetId: string; amount: string }[] };
type Ledger = { entries: { kind: string; lines: { accountCode: string; debit: string; credit: string; partyName?: string }[] }[] };
const doc = (page: Page, type: string, id: string) => api<DocJson>(page, `/docs/${type}/${id}`);
const accounts = (l: Ledger, n = 0) => l.entries[n].lines.map((x) => [x.accountCode, x.debit, x.credit]).sort((a, b) => (a[0] < b[0] ? -1 : 1));
const missing = (page: Page) => page.getByRole('region', { name: 'ยังขาดอะไร' });
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const pickEmployee = async (page: Page, q: string) => {
  await page.getByRole('combobox', { name: 'พนักงาน' }).fill(q);
  await page.getByRole('listbox').getByRole('option').first().waitFor();
  await page.keyboard.press('Enter');
};

test('ex-1 (issued by approve-and-issue): 2,855.00 owed to emp-02 under 2180; only the line with a tax invoice claims VAT (1170 140.00); the meal and the rest are cost', async ({ page }) => {
  await page.goto('/'); const id = await fixtureId(page, 'exUnpaid');
  await page.goto(`${BASE}/${id}`);
  await expect(page.getByTestId('doc-number')).toHaveText(/^EX-\d{6}-\d{4}$/);
  const ex = await doc(page, 'EX', id);
  expect(ex).toMatchObject({ status: 'issued', outstanding: '2855.00', totals: { net: '2680.00', vat: '175.00', total: '2855.00' }, party: { name: 'วิชาญ ขยันงาน' } });
  expect(ex.approval?.approvedBy).toBeTruthy();
  const ledger = await api<Ledger>(page, `/docs/EX/${id}/ledger`);
  expect(accounts(ledger)).toEqual([['1170', '140.00', '0.00'], ['2180', '0.00', '2855.00'], ['5140', '180.00', '0.00'], ['5150', '500.00', '0.00'], ['5160', '2000.00', '0.00'], ['5170', '35.00', '0.00']]);
  expect(ledger.entries[0].lines.find((l) => l.accountCode === '2180')?.partyName).toBe('วิชาญ ขยันงาน');
  // the late invoice (2026-03) forfeits its VAT
  const late = await fixtureId(page, 'exForfeit');
  expect(accounts(await api<Ledger>(page, `/docs/EX/${late}/ledger`))).toEqual([['2180', '0.00', '1070.00'], ['5120', '1000.00', '0.00'], ['5170', '70.00', '0.00']]);
});

test('EX -> PV: แปลงเป็น… makes a voucher draft for the outstanding; issuing it settles the claim, posts 2180 under the employee and withholds nothing', async ({ page }) => {
  await page.goto('/'); const id = await fixtureId(page, 'exUnpaid');
  await page.goto(`${BASE}/${id}`);
  await page.getByRole('button', { name: 'แปลงเป็น…' }).click();
  const dlg = page.getByRole('dialog');
  await expect(dlg.getByLabel('เอกสารปลายทาง')).toHaveValue('PV');
  await expect(dlg.getByText(/ไม่หักภาษี ณ ที่จ่าย/)).toBeVisible();
  await dlg.getByRole('button', { name: 'สร้างใบสำคัญจ่าย' }).click();
  await expect(page).toHaveURL(/\/purchases\/payment-vouchers\/[^/]+\/edit$/);
  await expect(page.getByRole('checkbox', { checked: true })).toHaveCount(1);
  await expect(missing(page)).toHaveText(/ครบแล้ว/);
  await expect(page.getByRole('region', { name: 'ยอดรวม' })).toContainText('2,855.00');
  await page.getByRole('button', { name: 'บันทึกและออกใบสำคัญจ่าย' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: /^ออกใบสำคัญจ่าย/ }).click();
  await expect(page.getByTestId('doc-number')).toHaveText(/^PV-\d{6}-\d{4}$/);
  const pv = await doc(page, 'PV', page.url().split('/').pop()!);
  expect(pv).toMatchObject({ totals: { total: '2855.00', wht: '0.00', cash: '2855.00' }, allocations: [{ targetId: id, amount: '2855.00' }] });
  expect(await doc(page, 'EX', id)).toMatchObject({ status: 'settled', outstanding: '0.00' });
  const ledger = await api<Ledger>(page, `/docs/PV/${page.url().split('/').pop()}/ledger`);
  expect(accounts(ledger)).toEqual([['1121', '0.00', '2855.00'], ['2180', '2855.00', '0.00']]);
  expect(ledger.entries[0].lines.find((l) => l.accountCode === '2180')?.partyName).toBe('วิชาญ ขยันงาน');
  await page.getByRole('tab', { name: 'เอกสารที่เกี่ยวข้อง' }).click();
  await expect(page.getByRole('link', { name: /WT-\d{6}-\d{4}/ })).toHaveCount(0); // no 50 tawi for a reimbursement
});

test('a settled claim offers no payment; the paid fixture is settled by pv-ex', async ({ page }) => {
  await page.goto('/'); const id = await fixtureId(page, 'exPaid');
  await page.goto(`${BASE}/${id}`);
  await expect(page.getByRole('button', { name: 'แปลงเป็น…' })).toBeDisabled();
  expect(await doc(page, 'EX', id)).toMatchObject({ status: 'settled', outstanding: '0.00' });
});

test('the vendor tax invoice of a line: with it the VAT is claimed (1170), without it the VAT is cost (5170)', async ({ page }) => {
  await page.goto(`${BASE}/new?role=accountant`);
  await pickEmployee(page, 'มาลี');
  await page.getByRole('combobox', { name: 'รายการ 1', exact: true }).fill('ค่าวัสดุสำนักงาน');
  await page.getByRole('textbox', { name: 'จำนวนเงินรายการ 1' }).fill('1000.00');
  await page.getByRole('combobox', { name: 'ภาษีรายการ 1' }).selectOption('S7');
  await expect(page.getByRole('region', { name: 'ใบกำกับภาษีของผู้ขาย (ภาษีซื้อ)' })).toBeVisible();
  await page.getByLabel('ชื่อผู้ขาย').fill('ร้านเครื่องเขียนสยาม');
  await page.getByLabel('เลขประจำตัวผู้เสียภาษีผู้ขาย').fill('1234567890123'); // wrong check digit
  await page.getByLabel('เลขที่ใบกำกับภาษี').fill('INV-9');
  await page.getByLabel('วันที่ใบกำกับภาษี').fill('2026-10-12');
  await page.getByRole('checkbox', { name: /ใบกำกับภาษีเต็มรูป/ }).check(); // ม.86/4: only a full tax invoice made out to the company is claimable
  await expect(missing(page)).toContainText('เลขประจำตัวผู้เสียภาษีของผู้ขายไม่ถูกต้อง'); // the server's rule, shown before issue
  await page.getByLabel('เลขประจำตัวผู้เสียภาษีผู้ขาย').fill('0105560001235');
  await expect(missing(page)).toHaveText(/ครบแล้ว/);
  await page.getByRole('button', { name: 'บันทึกและออกใบเบิกค่าใช้จ่าย' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: /^ส่งอนุมัติ|^ออก/ }).click();
  await expect(page.getByTestId('doc-number')).toHaveText(/^EX-\d{6}-\d{4}$/);
  const id = page.url().split('/').pop()!;
  expect(accounts(await api<Ledger>(page, `/docs/EX/${id}/ledger`))).toEqual([['1170', '70.00', '0.00'], ['2180', '0.00', '1070.00'], ['5100', '1000.00', '0.00']]); // no category chosen: the default expense account
});

test('non-VAT company: the claim is issued directly (no approval policy) and its VAT is cost', async ({ page }) => {
  await page.goto('/?company=nonvat'); const id = await fixtureId(page, 'nexIssued');
  await page.goto(`${BASE}/${id}`);
  await expect(page.getByTestId('doc-number')).toHaveText(/^EX-\d{6}-\d{4}$/);
  expect(accounts(await api<Ledger>(page, `/docs/EX/${id}/ledger`))).toEqual([['2180', '0.00', '856.00'], ['5140', '800.00', '0.00'], ['5170', '56.00', '0.00']]);
});

test('the employee is its own party kind: the claim offers employees only, vendor and bill pickers never do', async ({ page }) => {
  await page.goto(`${BASE}/new`);
  const emp = page.getByRole('combobox', { name: 'พนักงาน' });
  await emp.fill('ภูพาน'); // a vendor
  await expect(page.getByRole('listbox').getByRole('option')).toHaveCount(0);
  await emp.fill('มาลี');
  await expect(page.getByRole('listbox').getByRole('option')).toHaveCount(1);
  expect(await api<{ items: { kind: string }[] }>(page, '/parties?kind=vendor&limit=200').then((r) => r.items.some((p) => p.kind === 'employee'))).toBe(false);
  await page.goto('/purchases/bills/new');
  await page.getByRole('combobox', { name: 'ผู้ขาย' }).fill('มาลี');
  await expect(page.getByRole('listbox').getByRole('option')).toHaveCount(0);
});

test('EX paper: the employee, the tax invoice behind a line and the approval trail', async ({ page }) => {
  await page.goto('/'); const id = await fixtureId(page, 'exUnpaid');
  await page.goto(`/print/EX/${id}`);
  await page.waitForSelector('[data-paper-ready="true"]');
  const paper = page.locator('.paper-root');
  for (const t of ['EXPENSE CLAIM', 'ผู้เบิก', 'วิชาญ ขยันงาน', 'TX-77/1024', 'ส่งอนุมัติโดย', 'อนุมัติโดย', '2,855.00']) await expect(paper).toContainText(t);
});

test.describe('mobile', () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test('/purchases/expense-claims/new at 390 x 844: one amount line and a photo of the receipt, submitted for approval, no horizontal scroll', async ({ page }) => {
    await page.goto(`${BASE}/new?role=operator`);
    await pickEmployee(page, 'วิชาญ');
    await page.getByRole('combobox', { name: 'รายการ 1', exact: true }).fill('ค่าแท็กซี่ไปพบลูกค้า');
    await page.getByRole('textbox', { name: 'จำนวนเงินรายการ 1' }).fill('180.00');
    const camera = page.getByLabel('ถ่ายภาพใบเสร็จ');
    await expect(camera).toHaveAttribute('capture', 'environment');
    await expect(camera).toHaveAttribute('accept', 'image/*');
    await camera.setInputFiles({ name: 'receipt.png', mimeType: 'image/png', buffer: PNG });
    await expect(page.getByRole('link', { name: 'receipt.png' })).toBeVisible();
    await expect(missing(page)).toHaveText(/ครบแล้ว/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
    await page.getByRole('button', { name: 'ส่งอนุมัติ' }).first().click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'ส่งอนุมัติ' }).click();
    await expect(page).toHaveURL(new RegExp(`${BASE}/(?!new)[^/?]+$`));
    const id = page.url().split('/').pop()!;
    await expect.poll(async () => (await doc(page, 'EX', id)).status).toBe('pending');
    expect((await doc(page, 'EX', id)).number).toBeUndefined();
    expect((await api<unknown[]>(page, `/docs/EX/${id}/attachments`))).toHaveLength(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
  });
});

test('the "รออนุมัติ" saved view of the list shows the claim waiting for approval and nothing else', async ({ page }) => {
  await page.goto(`${BASE}?role=accountant`); await fixtureId(page, 'exPending');
  await page.getByRole('button', { name: 'รออนุมัติ' }).click();
  const rows = page.getByRole('row');
  await expect(rows.filter({ hasText: 'มาลี ใจงาม' })).toHaveCount(1);
  await expect(rows.filter({ hasText: 'วิชาญ ขยันงาน' })).toHaveCount(0);
});

test('an approver sees what is being approved: the lines of the pending claim with the vendor tax invoice behind them, and the receipt photo', async ({ page }) => {
  await page.goto('/?role=accountant'); const id = await fixtureId(page, 'exPending');
  await page.goto(`${BASE}/${id}`);
  const lines = page.getByTestId('lines-preview');
  await expect(lines).toContainText('ค่าอุปกรณ์สำนักงานซื้อด่วน');
  await expect(lines).toContainText('INV-5521 · ร้านเครื่องเขียนสยาม');
  await expect(page.getByTestId('approval-note')).toContainText('ส่งอนุมัติโดย');
  await page.getByRole('tab', { name: 'ไฟล์แนบ' }).click();
  await expect(page.getByRole('link', { name: 'ใบเสร็จร้านเครื่องเขียน.png' })).toBeVisible();
});
