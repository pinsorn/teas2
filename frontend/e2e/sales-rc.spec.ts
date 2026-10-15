import { expect, test, type Page } from '@playwright/test';
import { fixtureId } from './helpers/fixtures';
import { screenContract } from './helpers/screen-contract';

screenContract({ name: 'RC list', path: '/sales/receipts', heading: 'ใบเสร็จรับเงิน', company: 'both', states: ['empty', 'loading', 'error', 'forbidden'], forbiddenRole: 'admin', roles: ['operator', 'accountant'] });
screenContract({ name: 'RC view', path: async (p) => `/sales/receipts/${await fixtureId(p, 'rcMulti')}`, heading: /RC-\d{6}-\d{4}/, company: 'vat', otherCompany: 'not-found', states: ['loading', 'error', 'forbidden'] });
screenContract({ name: 'RC new', path: '/sales/receipts/new', heading: 'สร้างใบเสร็จรับเงิน', company: 'both', states: ['loading', 'error'] });

const api = <T,>(page: Page, path: string) => page.evaluate(async (p) => (await fetch(`/bff/v1${p}`)).json(), path) as Promise<T>;
type DocJson = { number: string; replacedById?: string; status: string; outstanding?: string; revision: number; totals: { total: string; wht?: string; cash?: string }; allocations?: { targetId: string; amount: string; wht?: string; certNumber?: string }[] };
const doc = (page: Page, type: string, id: string) => api<DocJson>(page, `/docs/${type}/${id}`);
const asNonVat = async (page: Page) => { await page.goto('/?company=nonvat'); await fixtureId(page, 'nrcCashBill'); }; // the worker starts after hydration, i.e. after the toolbar stored the company: wait for it before navigating on

test('receive one payment for two invoices with WHT from the first invoice view', async ({ page }) => {
  await page.goto('/'); const a = await fixtureId(page, 'rcTargetsA'); const b = await fixtureId(page, 'rcTargetsB');
  await page.goto(`/sales/tax-invoices/${a}`);
  await page.getByRole('link', { name: 'รับชำระ' }).click();
  const panel = page.getByRole('region', { name: 'รายการที่รับชำระ' });
  await expect(panel.getByRole('checkbox', { checked: true })).toHaveCount(1); // the invoice we came from, at the server's outstanding
  await panel.getByRole('checkbox').nth(1).check();               // second open TI of the same customer
  await panel.getByLabel(/จำนวนรับชำระ/).first().fill('1000.00');
  await panel.getByLabel(/ภาษีถูกหัก/).first().fill('30.00');
  await expect(page.getByRole('region', { name: 'ยอดรวม' })).toContainText('หัก ณ ที่จ่าย');
  await expect(page.getByRole('region', { name: 'ยอดรวม' })).toContainText('165,780.00'); // 1,000.00 + 164,780.00, summed by the server
  await page.keyboard.press('Control+Enter');
  await page.getByRole('alertdialog').getByRole('button', { name: /^ออกใบเสร็จรับเงิน$/ }).click();
  await expect(page.getByTestId('doc-number')).toHaveText(/^RC-\d{6}-\d{4}$/);
  await page.getByRole('tab', { name: 'เอกสารที่เกี่ยวข้อง' }).click();
  await expect(page.getByRole('link', { name: /TI-\d{6}-\d{4}/ })).toHaveCount(2);
  // the money: both targets follow the links, to the satang
  expect((await doc(page, 'TI', a)).outstanding).toBe('70.00'); // 1,070.00 - 1,000.00
  expect((await doc(page, 'TI', b)).outstanding).toBe('0.00');  // 164,780.00 settled in full
  expect((await doc(page, 'TI', b)).status).toBe('settled');
  const rcId = page.url().split('/').pop()!;
  const rc = await doc(page, 'RC', rcId);
  expect(rc.totals).toMatchObject({ total: '165780.00', wht: '30.00', cash: '165750.00' });
});

test('non-VAT cash bill: line grid visible; VAT company: line grid absent', async ({ page }) => {
  // the kit has no ARIA grid: the line editor is the section headed "รายการ" (a region), so that is what "the line grid" means here
  await page.goto('/');
  await page.goto('/sales/receipts/new?company=nonvat');
  await expect(page.getByRole('region', { name: 'รายการ', exact: true })).toBeVisible();
  await page.goto('/sales/receipts/new?company=vat');
  await expect(page.getByRole('heading', { level: 1, name: 'สร้างใบเสร็จรับเงิน' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'รายการ', exact: true })).toHaveCount(0);
});

test('cash bill: sold over the counter in the non-VAT company, no VAT anywhere, the paper prints its lines', async ({ page }) => {
  await asNonVat(page);
  await page.goto('/sales/receipts/new');
  await page.getByRole('combobox', { name: 'ลูกค้า' }).fill('ตลาดสด');
  await page.getByRole('option').first().waitFor();
  await page.keyboard.press('Enter');
  await page.getByRole('combobox', { name: 'รายการ 1', exact: true }).fill('ค่าเช่าแผงรายวัน');
  await page.getByRole('textbox', { name: 'จำนวนเงินรายการ 1' }).fill('850.00');
  await page.getByRole('textbox', { name: 'จำนวนเงินรายการ 1' }).press('Tab');
  await expect(page.getByRole('region', { name: 'ยังขาดอะไร' })).toHaveText(/ครบแล้ว/);
  await expect(page.getByRole('region', { name: 'ยอดรวม' })).toContainText('850.00');
  await page.keyboard.press('Control+Enter');
  await page.getByRole('alertdialog').getByRole('button', { name: /^ออกใบเสร็จรับเงิน$/ }).click();
  await expect(page.getByTestId('doc-number')).toHaveText(/^RC-\d{6}-\d{4}$/);
  const rc = await doc(page, 'RC', page.url().split('/').pop()!);
  expect(rc.totals).toMatchObject({ total: '850.00', cash: '850.00', wht: '0.00' });
  await expect(page.locator('.paper-root')).toContainText('ค่าเช่าแผงรายวัน');
  await expect(page.locator('.paper-root')).not.toContainText('ภาษีมูลค่าเพิ่ม');
});

test('"รับชำระ" on an invoice that is paid in full does not exist; on a partly paid IV it opens the receipt on the server balance', async ({ page }) => {
  await asNonVat(page); const settled = await fixtureId(page, 'ivSettled'); const partly = await fixtureId(page, 'ivPartly');
  await page.goto(`/sales/invoices/${settled}`);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('IV-');
  await expect(page.getByRole('link', { name: 'รับชำระ' })).toHaveCount(0);
  await page.goto(`/sales/invoices/${partly}`);
  await page.getByRole('link', { name: 'รับชำระ' }).click();
  const panel = page.getByRole('region', { name: 'รายการที่รับชำระ' });
  await expect(panel.getByLabel(/จำนวนรับชำระ/)).toHaveValue('5000.00'); // 8,000.00 - 3,000.00 received
});

test('billing statement -> receipt: every grouped invoice at its CURRENT outstanding (rc-multi paid part of both since the statement)', async ({ page }) => {
  await page.goto('/'); const bl = await fixtureId(page, 'blVat');
  await page.goto(`/sales/billing-statements/${bl}`);
  await page.getByRole('link', { name: 'รับชำระ' }).click();
  const panel = page.getByRole('region', { name: 'รายการที่รับชำระ' });
  await expect(panel.getByRole('checkbox', { checked: true })).toHaveCount(2);
  const values = await panel.getByLabel(/จำนวนรับชำระ/).evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value).sort());
  expect(values).toEqual(['63200.00', '761875.00']); // the statement itself says 64,200.00 / 762,375.00
});

test('late 50 tawi: the certificate number is a free in-place edit - same number, revision +1, the books untouched, the activity says which number', async ({ page }) => {
  await page.goto('/'); const id = await fixtureId(page, 'rcNoCert');
  const before = await doc(page, 'RC', id);
  const ledger0 = await api<{ entries: unknown[] }>(page, `/docs/RC/${id}/ledger`);
  await page.goto(`/sales/receipts/${id}/edit`);
  await page.getByRole('textbox', { name: /^เลขที่หนังสือรับรองของ/ }).fill('ท.2569/0777');
  await expect(page.getByRole('region', { name: 'ยังขาดอะไร' })).toHaveText(/ครบแล้ว/);
  await page.getByRole('button', { name: 'บันทึกการแก้ไข' }).click();
  const dlg = page.getByRole('alertdialog', { name: /แผนการแก้ไข/ });
  await expect(dlg).toContainText('แก้ไข'); // one revise step, nothing is cancelled
  await expect(dlg).not.toContainText('ยกเลิก RC');
  await dlg.getByRole('button', { name: 'ยืนยันทั้งหมด' }).click();
  await expect(page.getByTestId('doc-number')).toHaveText(before.number);
  const after = await doc(page, 'RC', id);
  expect(after.revision).toBe(before.revision + 1);
  expect(after.totals).toEqual(before.totals);
  expect(after.allocations![0].certNumber).toBe('ท.2569/0777');
  expect(await api(page, `/docs/RC/${id}/ledger`)).toEqual(ledger0);
  await page.getByRole('tab', { name: 'กิจกรรม' }).click();
  await expect(page.getByText('บันทึกเลขที่หนังสือรับรองหัก ณ ที่จ่าย ท.2569/0777')).toBeVisible();
});

test('cancelling the receipt gives every invoice its pre-receipt outstanding back', async ({ page }) => {
  await page.goto('/'); const id = await fixtureId(page, 'rcMulti');
  expect((await doc(page, 'TI', 'ti-057')).outstanding).toBe('63200.00');
  await page.goto(`/sales/receipts/${id}`);
  await page.getByRole('button', { name: 'ยกเลิกเอกสาร' }).click();
  const dlg = page.getByRole('alertdialog');
  await dlg.getByRole('combobox').click();
  await page.getByRole('option').first().click();
  await dlg.getByRole('button', { name: 'ยืนยันยกเลิก' }).click();
  await expect(page.locator('[data-status="cancelled"]').first()).toBeVisible();
  expect((await doc(page, 'TI', 'ti-057')).outstanding).toBe('64200.00');
  expect((await doc(page, 'TI', 'spike-60')).outstanding).toBe('762375.00');
  expect((await doc(page, 'TI', 'ti-057')).status).toBe('issued');
  const ledger = await api<{ entries: { kind: string }[] }>(page, `/docs/RC/${id}/ledger`);
  expect(ledger.entries.map((e) => e.kind)).toEqual(['original', 'reversal']);
});

test('reissuing the receipt through the correction plan keeps each invoice\'s settled amount and the bank it posted to (multi-target vector)', async ({ page }) => {
  await page.goto('/'); const id = await fixtureId(page, 'rcMulti');
  const before = await doc(page, 'RC', id);
  await page.goto(`/sales/receipts/${id}/edit`);
  await page.getByLabel(/ภาษีถูกหัก ณ ที่จ่ายของ TI-202601-0003/).fill('25.00'); // ti-057 (the rows are ordered by invoice date)
  await expect(page.getByRole('region', { name: 'ยังขาดอะไร' })).toHaveText(/ครบแล้ว/);
  await page.getByRole('button', { name: 'บันทึกการแก้ไข' }).click();
  const dlg = page.getByRole('alertdialog', { name: /แผนการแก้ไข/ });
  await expect(dlg).toContainText('ยกเลิก RC');
  await dlg.getByRole('button', { name: 'ยืนยันทั้งหมด' }).click();
  // where the plan lands (the original or the new receipt) is the correction flow's business, not this task's: read the outcome from the API
  await expect.poll(async () => (await doc(page, 'RC', id)).status).toBe('replaced');
  const newId = (await doc(page, 'RC', id)).replacedById!;
  const nw = await doc(page, 'RC', newId);
  expect(nw.number).not.toBe(before.number);
  expect(nw.allocations!.map((x) => [x.targetId, x.amount, x.wht])).toEqual([['ti-057', '1000.00', '25.00'], ['spike-60', '500.00', undefined]]);
  expect(nw.totals).toMatchObject({ total: '1500.00', wht: '25.00', cash: '1475.00' });
  expect((await doc(page, 'RC', id)).status).toBe('replaced');
  expect((await doc(page, 'TI', 'ti-057')).outstanding).toBe('63200.00');
  expect((await doc(page, 'TI', 'spike-60')).outstanding).toBe('761875.00');
  const led = await api<{ entries: { lines: { accountCode: string; debit: string }[] }[] }>(page, `/docs/RC/${newId}/ledger`);
  expect(led.entries[0].lines.find((l) => l.accountCode === '1121')?.debit).toBe('1475.00'); // the account the original posted to
});

test('deposit: a customer pays in advance - no invoice, the unallocated money is kept as a customer deposit', async ({ page }) => {
  await page.goto('/');
  await page.goto('/sales/receipts/new');
  await page.getByRole('combobox', { name: 'ลูกค้า' }).fill('ไทยพัฒนา');
  await page.getByRole('option').first().waitFor();
  await page.keyboard.press('Enter');
  await page.getByRole('textbox', { name: /^เงินรับล่วงหน้า/ }).fill('5000.00');
  await expect(page.getByRole('region', { name: 'ยังขาดอะไร' })).toHaveText(/ครบแล้ว/);
  await page.keyboard.press('Control+Enter');
  await page.getByRole('alertdialog').getByRole('button', { name: /^ออกใบเสร็จรับเงิน$/ }).click();
  await expect(page.getByTestId('doc-number')).toHaveText(/^RC-\d{6}-\d{4}$/);
  const rc = await doc(page, 'RC', page.url().split('/').pop()!);
  expect(rc.totals).toMatchObject({ total: '5000.00', cash: '5000.00' });
  await page.getByRole('tab', { name: 'ผลต่อบัญชี' }).click();
  await expect(page.getByRole('tabpanel')).toContainText('2140');
});

test('the receipt paper lists each settled invoice with its WHT and the server totals; a cash bill prints its lines', async ({ page }) => {
  await page.goto('/'); const id = await fixtureId(page, 'rcMulti');
  await page.goto(`/print/RC/${id}`);
  await page.waitForSelector('[data-paper-ready="true"]');
  const paper = page.locator('.paper-root');
  await expect(paper).toContainText('ใบเสร็จรับเงิน');
  await expect(paper).toContainText('RECEIPT');
  await expect(paper).toContainText('ใบกำกับภาษี TI-');
  for (const t of ['1,000.00', '30.00', '500.00', 'รับเงินสุทธิ', '1,470.00', 'ภาษีถูกหัก ณ ที่จ่าย', 'รวมรับชำระ', '1,500.00', 'หนึ่งพันห้าร้อยบาทถ้วน', 'โอนเงิน']) await expect(paper).toContainText(t);
  await expect(paper).not.toContainText('ภาษีมูลค่าเพิ่ม');
  await page.goto('/?company=nonvat'); const cash = await fixtureId(page, 'nrcCashBill');
  await page.goto(`/print/RC/${cash}`);
  await page.waitForSelector('[data-paper-ready="true"]');
  await expect(page.locator('.paper-root')).toContainText('ค่าเช่าแผงชั่วคราวรายวัน');
  await expect(page.locator('.paper-root')).toContainText('850.00');
});
