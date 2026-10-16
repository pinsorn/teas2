import { expect, test, type Page } from '@playwright/test';
import { fixtureId } from './helpers/fixtures';
import { screenContract } from './helpers/screen-contract';

screenContract({ name: 'PV list', path: '/purchases/payment-vouchers', heading: 'ใบสำคัญจ่าย', company: 'both', states: ['empty', 'loading', 'error', 'forbidden'], forbiddenRole: 'admin', roles: ['operator', 'accountant'] });
screenContract({ name: 'PV view', path: async (p) => `/purchases/payment-vouchers/${await fixtureId(p, 'pvMultiWt')}`, heading: /PV-\d{6}-\d{4}/, company: 'vat', otherCompany: 'not-found', states: ['loading', 'error', 'forbidden', 'locked'], roles: ['operator', 'accountant'] });
screenContract({ name: 'PV new', path: '/purchases/payment-vouchers/new', heading: 'สร้างใบสำคัญจ่าย', company: 'both', states: ['loading', 'error'] });
screenContract({ name: 'WT list', path: '/tax/wht-certificates', heading: 'หนังสือรับรองการหักภาษี ณ ที่จ่าย', company: 'both', states: ['empty', 'loading', 'error', 'forbidden'], forbiddenRole: 'admin', roles: ['operator', 'accountant'] }); // the admin lacks doc.WT.read
screenContract({ name: 'WT view', path: async (p) => `/tax/wht-certificates/${await fixtureId(p, 'wtIssued')}`, heading: /WT-\d{6}-\d{4}/, company: 'vat', otherCompany: 'not-found', states: ['loading', 'error', 'forbidden'], roles: ['accountant'] });

const api = <T,>(page: Page, path: string) => page.evaluate(async (p) => (await fetch(`/bff/v1${p}`)).json(), path) as Promise<T>;
type Ledger = { entries: { kind: string; lines: { accountCode: string; debit: string; credit: string }[] }[] };
type DocJson = { number: string; status: string; outstanding?: string; totals: { total: string; wht?: string; cash?: string }; allocations?: { targetId: string; amount: string }[]; lines: { pnd36?: boolean }[];
  header: { whtTax?: string; whtForm?: string; whtTypeCode?: string }; cancel?: { reasonText: string } };
const accounts = (l: Ledger, n = 0) => l.entries[n].lines.map((x) => [x.accountCode, x.debit, x.credit]).sort((a, b) => (a[0] < b[0] ? -1 : 1));
const chain = (page: Page, id: string) => api<{ nodes: { id: string; type: string; status: string }[]; edges: { from: string; to: string; kind: string; active: boolean }[] }>(page, `/docs/PV/${id}/chain`);
const doc = (page: Page, type: string, id: string) => api<DocJson>(page, `/docs/${type}/${id}`);
const BASE = '/purchases/payment-vouchers';

test('VAT vendor with an S7 line: refusal banner -> บันทึกซื้อ (มีใบกำกับภาษี) -> dialog -> the bill is paid by this voucher -> issue', async ({ page }) => {
  await page.goto(`${BASE}/new`);
  await page.getByRole('combobox', { name: 'ผู้ขาย' }).fill('ภูพาน');
  await page.getByRole('option').first().waitFor();
  await page.keyboard.press('Enter');
  await page.getByRole('combobox', { name: 'ภาษีรายการ 1' }).selectOption('S7');
  await page.getByRole('combobox', { name: 'รายการ 1', exact: true }).fill('ค่าที่ปรึกษา');
  await page.getByRole('textbox', { name: 'จำนวนเงินรายการ 1' }).fill('1000.00');
  const banner = page.getByTestId('pv-needs-bill');
  await expect(banner).toContainText('บันทึกซื้อ (มีใบกำกับภาษี)');
  await expect(page.getByRole('button', { name: 'บันทึกและออกใบสำคัญจ่าย' })).toBeDisabled();
  await banner.getByRole('button', { name: 'บันทึกซื้อ (มีใบกำกับภาษี)' }).click();
  const dlg = page.getByRole('alertdialog');
  await dlg.getByLabel('เลขที่เอกสารของผู้ขาย').fill('QB-E2E-1');
  await dlg.getByRole('button', { name: 'บันทึกและใช้กับใบสำคัญจ่ายนี้' }).click();
  await expect(dlg).toBeHidden();
  await expect(page.getByRole('checkbox', { checked: true })).toHaveCount(1); // the allocation of the new bill
  await expect(banner).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'ยังขาดอะไร' })).toHaveText(/ครบแล้ว/);
  await expect(page.getByRole('region', { name: 'ยอดรวม' })).toContainText('1,070.00');
  await page.getByRole('button', { name: 'บันทึกและออกใบสำคัญจ่าย' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: /^ออกใบสำคัญจ่าย/ }).click();
  await expect(page.getByTestId('doc-number')).toHaveText(/^PV-\d{6}-\d{4}$/);
  const pv = await doc(page, 'PV', page.url().split('/').pop()!);
  expect(pv.allocations).toHaveLength(1);
  const pb = await doc(page, 'PB', pv.allocations![0].targetId);
  expect(pb).toMatchObject({ status: 'settled', outstanding: '0.00', totals: { total: '1070.00' } });
  expect(pv.totals).toMatchObject({ total: '1070.00', wht: '0.00', cash: '1070.00' });
});

test('pv-multi (pb-2 half + part of pb-po + a transport line): two WHT types, two WTs in the chain, the journal ties out', async ({ page }) => {
  await page.goto('/'); const id = await fixtureId(page, 'pvMultiWt');
  await page.goto(`${BASE}/${id}`);
  await expect(page.getByTestId('doc-number')).toHaveText(/^PV-/);
  await page.getByRole('tab', { name: 'เอกสารที่เกี่ยวข้อง' }).click();
  await expect(page.getByRole('link', { name: /WT-\d{6}-\d{4}/ })).toHaveCount(2);
  const pv = await doc(page, 'PV', id);
  expect(pv.totals).toMatchObject({ total: '15105.00', wht: '288.00', cash: '14817.00' }); // 12,305.00 + 1,000.00 + 1,800.00; SVC 270.00 + TRANS 18.00
  const c = await chain(page, id);
  const wts = await Promise.all(c.edges.filter((e) => e.kind === 'issues' && e.active).map((e) => doc(page, 'WT', e.to)));
  expect(wts.map((w) => [w.header.whtTypeCode, w.header.whtTax]).sort()).toEqual([['SVC', '270.00'], ['TRANS', '18.00']]);
  expect(accounts(await api<Ledger>(page, `/docs/PV/${id}/ledger`))).toEqual([['1121', '0.00', '14817.00'], ['2110', '13305.00', '0.00'], ['2132', '0.00', '288.00'], ['5140', '1800.00', '0.00']]);
  expect((await doc(page, 'PB', 'pb-2')).outstanding).toBe('12305.00');
});

test('pv-pay1 pays pb-1 in full: RENT 5 % of the net after the vendor credit; pv-gross grosses up; pv-foreign is PND.54 with a PP.36 line', async ({ page }) => {
  await page.goto('/'); await fixtureId(page, 'pvMultiWt');
  expect(accounts(await api<Ledger>(page, '/docs/PV/pv-pay1/ledger'))).toEqual([['1121', '0.00', '22950.00'], ['2110', '24075.00', '0.00'], ['2132', '0.00', '1125.00']]);
  expect((await doc(page, 'PB', 'pb-1'))).toMatchObject({ status: 'settled', outstanding: '0.00' });
  expect(accounts(await api<Ledger>(page, '/docs/PV/pv-gross/ledger'))).toEqual([['1121', '0.00', '5000.00'], ['2131', '0.00', '154.64'], ['5120', '5000.00', '0.00'], ['5180', '154.64', '0.00']]);
  expect(accounts(await api<Ledger>(page, '/docs/PV/pv-foreign/ledger'))).toEqual([['1121', '0.00', '10000.00'], ['2134', '0.00', '1764.71'], ['5120', '10000.00', '0.00'], ['5180', '1764.71', '0.00']]);
  const foreign = await doc(page, 'PV', 'pv-foreign');
  expect(foreign.lines[0].pnd36).toBe(true);
  const wt = await doc(page, 'WT', (await chain(page, 'pv-foreign')).edges.find((e) => e.kind === 'issues')!.to);
  expect(wt.header).toMatchObject({ whtForm: 'PND54', whtTypeCode: 'FOR-SVC', whtTax: '1764.71' });
});

test('non-VAT company: npv-1 pays npb-1 (1,070.00, the vendor VAT is cost): AP cleared, 1170 never moves', async ({ page }) => {
  await page.goto('/?company=nonvat'); await fixtureId(page, 'npbVatToCost');
  expect((await doc(page, 'PB', 'npb-1'))).toMatchObject({ status: 'settled', outstanding: '0.00' });
  expect(accounts(await api<Ledger>(page, '/docs/PV/npv-1/ledger'))).toEqual([['1121', '0.00', '1070.00'], ['2110', '1070.00', '0.00']]);
});

test('cancelling a voucher restores what it paid and cancels its certificates; a cancelled voucher shows its cancelled certificate', async ({ page }) => {
  await page.goto('/'); const id = await fixtureId(page, 'pvMultiWt'); const wtId = await fixtureId(page, 'wtCancelled');
  await page.goto(`${BASE}/${id}`);
  await page.getByRole('button', { name: 'ยกเลิกเอกสาร' }).click();
  const dlg = page.getByRole('alertdialog');
  await dlg.getByRole('combobox').click();
  await page.getByRole('option').first().click();
  await dlg.getByRole('button', { name: 'ยืนยันยกเลิก' }).click();
  await expect(page.locator('[data-status="cancelled"]').first()).toBeVisible();
  expect((await doc(page, 'PB', 'pb-2')).outstanding).toBe('24610.00');
  expect((await doc(page, 'PB', 'pb-po')).outstanding).toBe('2033.00');
  const c = await chain(page, id);
  const wts = await Promise.all(c.edges.filter((e) => e.kind === 'issues').map((e) => doc(page, 'WT', e.to)));
  expect(wts).toHaveLength(2);
  for (const w of wts) expect(w).toMatchObject({ status: 'cancelled', cancel: { reasonText: 'ยกเลิกตามใบสำคัญจ่าย' } });
  await page.goto(`/tax/wht-certificates/${wtId}`);
  await expect(page.locator('[data-status="cancelled"]').first()).toBeVisible();
});

test('WT view: print is the only action; the paper has two copies and is frozen at the first print', async ({ page }) => {
  await page.goto('/'); const id = await fixtureId(page, 'wtIssued');
  await page.goto(`/tax/wht-certificates/${id}`);
  await expect(page.getByRole('link', { name: 'พิมพ์' })).toBeVisible();
  for (const name of ['แก้ไข', 'ยกเลิกเอกสาร', 'คัดลอกเป็นใบใหม่']) await expect(page.getByRole('button', { name })).toHaveCount(0);
  await page.goto(`/print/WT/${id}`);
  await page.waitForSelector('[data-paper-ready="true"]');
  const paper = page.locator('.paper-root');
  await expect(paper.locator('[data-paper-page]')).toHaveCount(2);
  await expect(paper).toContainText('ฉบับที่ 1');
  await expect(paper).toContainText('ฉบับที่ 2');
  await expect(paper.locator('[data-field="tax-total"]').first()).toHaveText('1,125.00');
  await expect(paper).toContainText('หนึ่งพันหนึ่งร้อยยี่สิบห้าบาทถ้วน');
  // the first print freezes it: rename the payee afterwards, the printed paper does not change
  await page.evaluate(async (wt) => { await fetch(`/bff/v1/docs/WT/${wt}/printed`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ copy: false }) }); }, id);
  await page.evaluate(() => {
    const k = Object.keys(localStorage).find((x) => x.startsWith('teas2.mock.state'))!;
    const s = JSON.parse(localStorage.getItem(k)!);
    s.companies[0].legalNameTh = 'ชื่อใหม่หลังพิมพ์ จำกัด';
    localStorage.setItem(k, JSON.stringify(s));
  });
  await page.goto(`/print/WT/${id}?copy=1`);
  await page.waitForSelector('[data-paper-ready="true"]');
  await expect(page.locator('.paper-root')).not.toContainText('ชื่อใหม่หลังพิมพ์');
});

test('PV paper: the settled bills, the WHT per type, the payment and the four signatures', async ({ page }) => {
  await page.goto('/'); const id = await fixtureId(page, 'pvMultiWt');
  await page.goto(`/print/PV/${id}`);
  await page.waitForSelector('[data-paper-ready="true"]');
  const paper = page.locator('.paper-root');
  for (const t of ['PAYMENT VOUCHER', 'บันทึกซื้อ PB-', '12,305.00', 'ค่าขนส่ง 1%', 'ค่าบริการ 3%', '14,817.00', 'รวมจ่ายชำระ', '15,105.00', 'ผู้จัดทำ', 'ผู้ตรวจ', 'ผู้อนุมัติ', 'ผู้รับเงิน']) await expect(paper).toContainText(t);
});

test.describe('mobile', () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test('the voucher editor, the quick-bill refusal and the voucher view fit a phone (no horizontal page scroll)', async ({ page }) => {
    await page.goto(`${BASE}/new`);
    await page.getByRole('combobox', { name: 'ผู้ขาย' }).fill('ภูพาน');
    await page.getByRole('option').first().waitFor();
    await page.keyboard.press('Enter');
    await page.getByRole('combobox', { name: 'ภาษีรายการ 1' }).selectOption('S7');
    await page.getByRole('textbox', { name: 'จำนวนเงินรายการ 1' }).fill('500.00');
    await expect(page.getByTestId('pv-needs-bill')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
    await page.goto('/'); const id = await fixtureId(page, 'pvMultiWt');
    await page.goto(`${BASE}/${id}`);
    await expect(page.getByTestId('doc-number')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
  });
});
