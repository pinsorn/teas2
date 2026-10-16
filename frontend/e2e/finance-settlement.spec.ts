import { expect, test, type Page } from '@playwright/test';
import { axeClean } from './helpers/axe';
import { fixtureId } from './helpers/fixtures';
import { screenContract } from './helpers/screen-contract';

const STATES = ['empty', 'loading', 'error', 'forbidden'] as const;
const shot = async (page: Page, name: string) => { if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/${name}.png`, fullPage: true }); };

// deposits and settlements are read with bank.read (the operator reads); posting needs bank.manage
screenContract({ name: 'deposits and advances', path: '/finance/deposits', heading: 'มัดจำและเงินล่วงหน้า', company: 'both', states: [...STATES], roles: ['accountant', 'operator'] });
screenContract({ name: 'settlements list', path: '/finance/settlements', heading: 'หักกลบ/ปรับปรุงการชำระ', company: 'both', states: [...STATES], roles: ['accountant', 'operator'] });
// a settlement belongs to one company: the other one answers "not found"
screenContract({ name: 'settlement view', path: '/finance/settlements/stl-001', heading: 'STL-001', company: 'vat', otherCompany: 'not-found', states: ['loading', 'error', 'forbidden'], roles: ['accountant', 'operator'] });

test.beforeEach(async ({ page }) => { await page.goto('/'); await page.evaluate(() => localStorage.clear()); await page.reload(); });

/** The document number the server gave a fixture document. */
async function numberOf(page: Page, type: string, id: string): Promise<string> {
  return page.evaluate(async ([t, i]) => ((await (await fetch(`/bff/v1/docs/${t}/${i}`)).json()) as { number: string }).number, [type, id]);
}
const dialog = (page: Page) => page.getByRole('dialog', { name: 'สร้างรายการหักกลบ / ปรับปรุงการชำระ' });

test('apply the deposit rc-dep of pc-08 to its unpaid invoice: settled, locked both ways, reversible from the lock', async ({ page }) => {
  const rcId = await fixtureId(page, 'rcDeposit'), tiId = await fixtureId(page, 'tiDeposit');
  const [rcNo, tiNo] = [await numberOf(page, 'RC', rcId), await numberOf(page, 'TI', tiId)];
  await page.goto('/finance/deposits');
  await expect(page.getByRole('heading', { level: 1, name: 'มัดจำและเงินล่วงหน้า' })).toBeVisible();
  await expect(page.getByTestId('deposit-vat-note')).toContainText('รอผลวิจัย SP-R');
  const customers = page.getByRole('region', { name: 'เงินรับล่วงหน้าจากลูกค้า' });
  await expect(customers.getByRole('row', { name: new RegExp(rcNo) })).toContainText('5,000.00');
  await shot(page, 'deposits');
  await customers.getByRole('button', { name: new RegExp(`นำไปหักกับใบแจ้งหนี้ ${rcNo}`) }).click();
  const d = dialog(page);
  await expect(d.getByRole('checkbox', { name: `เลือก ${rcNo}` })).toBeChecked(); // the deposit arrives ticked
  await d.getByRole('checkbox', { name: `เลือก ${tiNo}` }).check();
  await expect(d.getByLabel(`จำนวนที่หักของ ${tiNo}`)).toHaveValue('3210.00');
  await expect(d.getByLabel(`จำนวนที่หักของ ${rcNo}`)).toHaveValue('3210.00'); // one row each side: both take the smaller
  await shot(page, 'settlement-form');
  await axeClean(page);
  await d.getByRole('button', { name: 'ลงรายการ', exact: true }).click();
  await expect(page).toHaveURL(/\/finance\/settlements\/stl-002$/);
  await expect(page.getByRole('heading', { level: 1, name: 'STL-002' })).toBeVisible();
  await expect(page.getByText('ลงบัญชีแล้ว').first()).toBeVisible();
  const journal = page.getByRole('region', { name: /รายการบัญชีเดิม/ });
  await expect(journal).toContainText('2140');
  await expect(journal).toContainText('1130');
  await shot(page, 'settlement-posted');
  await axeClean(page);

  // the invoice is settled and locked; the deposit has 1,790.00 left and is locked as well
  await page.goto(`/sales/tax-invoices/${tiId}`);
  await expect(page.getByTestId('doc-number')).toHaveText(tiNo);
  const banner = page.getByRole('status', { name: /ล็อก|lock/i }).first();
  await expect(banner).toContainText('ใช้ในรายการหักกลบ/ใช้เงินมัดจำ STL-002 แล้ว');
  await expect(page.getByRole('button', { name: 'ยกเลิกเอกสาร' })).toBeDisabled();
  await page.goto('/finance/deposits');
  await expect(page.getByRole('region', { name: 'เงินรับล่วงหน้าจากลูกค้า' }).getByRole('row', { name: new RegExp(rcNo) })).toContainText('1,790.00');
  await page.goto(`/sales/receipts/${rcId}`);
  const rcBanner = page.getByRole('status', { name: /ล็อก|lock/i }).first();
  await expect(rcBanner).toContainText('STL-002');
  await expect(page.getByRole('button', { name: 'ยกเลิกเอกสาร' })).toBeDisabled();
  await shot(page, 'deposit-rc-locked');
  await axeClean(page);
  // the chain names the settlement
  await page.getByRole('tab', { name: 'เอกสารที่เกี่ยวข้อง' }).click();
  await expect(page.getByRole('link', { name: /หักกลบ \/ ใช้เงินมัดจำ STL-002/ })).toBeVisible();

  // the exit: reverse the settlement from the lock
  await rcBanner.getByRole('button', { name: 'ย้อนรายการหักกลบ' }).click();
  await expect(page).toHaveURL(/\/finance\/settlements\/stl-002$/);
  await page.getByRole('button', { name: 'ย้อนรายการหักกลบ' }).click();
  const confirm = page.getByRole('alertdialog');
  await expect(confirm.getByRole('button', { name: 'ย้อนรายการ', exact: true })).toBeDisabled(); // a reason is required
  await confirm.getByLabel('เหตุผลที่ย้อนรายการ').fill('ลูกค้าขอเปลี่ยนใบแจ้งหนี้');
  await confirm.getByRole('button', { name: 'ย้อนรายการ', exact: true }).click();
  await expect(page.getByText(/ย้อนรายการเมื่อ/)).toBeVisible();
  await expect(page.getByRole('region', { name: /รายการกลับรายการ/ })).toBeVisible();
  await shot(page, 'settlement-reversed');
  await page.goto(`/sales/tax-invoices/${tiId}`);
  await expect(page.getByText('ใช้ในรายการหักกลบ')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'ยกเลิกเอกสาร' })).toBeEnabled();
});

test('the seeded settlement locks its deposit receipt; the operator reads but cannot post or reverse', async ({ page }) => {
  await page.goto(`/sales/receipts/${await fixtureId(page, 'rcDepositApplied')}`);
  await expect(page.getByRole('status', { name: /ล็อก|lock/i }).first()).toContainText('STL-001');
  await page.goto('/finance/settlements/stl-001?role=operator');
  await expect(page.getByRole('heading', { level: 1, name: 'STL-001' })).toBeVisible();
  const reverse = page.getByRole('button', { name: 'ย้อนรายการหักกลบ' });
  await expect(reverse).toBeDisabled();
  await expect(page.getByText('ต้องมีสิทธิ์ bank.manage')).toBeVisible();
  await page.goto('/finance/deposits?role=operator');
  await expect(page.getByRole('button', { name: 'สร้างรายการหักกลบ' })).toBeDisabled();
  await page.goto('/finance/settlements?role=operator');
  await expect(page.getByRole('button', { name: 'สร้างรายการ' }).first()).toBeDisabled();
});

test('netting the linked customer / vendor pair, then a write-off above the tolerance is refused with its reason', async ({ page }) => {
  await page.goto('/finance/settlements');
  await expect(page.getByRole('heading', { level: 1, name: 'หักกลบ/ปรับปรุงการชำระ' })).toBeVisible();
  await page.getByRole('button', { name: 'สร้างรายการ' }).first().click();
  const d = dialog(page);
  await d.getByLabel('ประเภทรายการ').selectOption({ label: 'หักกลบลูกหนี้กับเจ้าหนี้' });
  await d.getByLabel(/ลูกค้า ⇄ ผู้ขาย/).selectOption({ index: 1 });
  const [apNo, arNo] = [await numberOf(page, 'PB', 'pb-net'), await numberOf(page, 'TI', 'ti-net')];
  await d.getByRole('checkbox', { name: `เลือก ${apNo}` }).check();
  await d.getByRole('checkbox', { name: `เลือก ${arNo}` }).check();
  await expect(d.getByLabel(`จำนวนที่หักของ ${arNo}`)).toHaveValue('4280.00'); // the smaller of the two: equal both sides
  await shot(page, 'settlement-netting');
  await d.getByRole('button', { name: 'ลงรายการ', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'STL-002' })).toBeVisible();
  await expect(page.getByText('หักกลบลูกหนี้กับเจ้าหนี้').first()).toBeVisible();
  await expect(page.getByRole('region', { name: /รายการบัญชีเดิม/ })).toContainText('2110');
  await page.goto(`/sales/tax-invoices/${await fixtureId(page, 'tiDeposit')}`); // an untouched invoice stays free
  await expect(page.getByText('ใช้ในรายการหักกลบ')).toHaveCount(0);

  // a write-off of 100.01 is above the small write-off tolerance of 100.00
  await page.goto('/finance/settlements');
  await page.getByRole('button', { name: 'สร้างรายการ' }).first().click();
  const w = dialog(page);
  await w.getByLabel('ประเภทรายการ').selectOption({ label: 'ตัดส่วนต่างเล็กน้อย' });
  await w.getByLabel('คู่ค้า', { exact: true }).selectOption({ label: 'บริษัท ไทยพัฒนาก่อสร้าง จำกัด' });
  const tiNo = await numberOf(page, 'TI', await fixtureId(page, 'tiDeposit'));
  await w.getByRole('checkbox', { name: `เลือก ${tiNo}` }).check();
  await w.getByLabel(`จำนวนที่หักของ ${tiNo}`).fill('100.01');
  await w.getByLabel('จำนวนส่วนต่าง').fill('100.01');
  await w.getByRole('button', { name: 'ลงรายการ', exact: true }).click();
  await expect(w.getByRole('alert')).toContainText('เกินเกณฑ์ที่กำหนด ต้องออกใบลดหนี้หรือรับชำระเพิ่ม');
  await shot(page, 'settlement-beyond-tolerance');
  await axeClean(page);
});
