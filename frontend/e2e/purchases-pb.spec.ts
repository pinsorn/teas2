import { expect, test, type Page } from '@playwright/test';
import { fixtureId } from './helpers/fixtures';
import { screenContract } from './helpers/screen-contract';

screenContract({ name: 'PB list', path: '/purchases/bills', heading: 'บันทึกซื้อ/ค่าใช้จ่าย', company: 'both', states: ['empty', 'loading', 'error', 'forbidden'], forbiddenRole: 'admin', roles: ['operator', 'accountant'] });
screenContract({ name: 'PB view', path: async (p) => `/purchases/bills/${await fixtureId(p, 'pbMixedVat')}`, heading: /PB-\d{6}-\d{4}/, company: 'vat', otherCompany: 'not-found', states: ['loading', 'error', 'forbidden', 'locked'], roles: ['operator', 'accountant'] });
screenContract({ name: 'PB new', path: '/purchases/bills/new', heading: 'สร้างบันทึกซื้อ/ค่าใช้จ่าย', company: 'both', states: ['loading', 'error'] });
screenContract({ name: 'PCN list', path: '/purchases/vendor-notes', heading: 'ใบลดหนี้จากผู้ขาย', company: 'both', states: ['empty', 'loading', 'error', 'forbidden'], forbiddenRole: 'admin', roles: ['operator', 'accountant'] });
screenContract({ name: 'PDN list', path: '/purchases/vendor-debit-notes', heading: 'ใบเพิ่มหนี้จากผู้ขาย', company: 'both', states: ['empty', 'loading', 'error', 'forbidden'], forbiddenRole: 'admin', roles: ['operator', 'accountant'] });
screenContract({ name: 'PCN view', path: async (p) => `/purchases/vendor-notes/${await fixtureId(p, 'pcnIssued')}`, heading: /PCN-\d{6}-\d{4}/, company: 'vat', otherCompany: 'not-found', states: ['loading', 'error', 'forbidden'] });
screenContract({ name: 'PDN view', path: async (p) => `/purchases/vendor-debit-notes/${await fixtureId(p, 'pdnIssued')}`, heading: /PDN-\d{6}-\d{4}/, company: 'vat', otherCompany: 'not-found', states: ['loading', 'error', 'forbidden'] });
screenContract({ name: 'PCN new (pick the bill)', path: '/purchases/vendor-notes/new', heading: /เลือกบันทึกซื้อที่จะบันทึกใบลดหนี้จากผู้ขาย/, company: 'both', states: ['loading', 'error'] });

const BASE = '/purchases/bills';
const api = <T,>(page: Page, path: string) => page.evaluate(async (p) => (await fetch(`/bff/v1${p}`)).json(), path) as Promise<T>;
type DocJson = { number: string; status: string; outstanding?: string; totals: { net: string; vat: string; total: string }; header: { claimPeriod?: string; vendorDocNumber?: string; refDocId?: string; partyId?: string };
  lines: { sourceLineId?: string; qty: string; unitPrice: string; expenseCategory?: string }[] };
type Ledger = { entries: { kind: string; lines: { accountCode: string; debit: string; credit: string }[] }[] };
const doc = (page: Page, type: string, id: string) => api<DocJson>(page, `/docs/${type}/${id}`);
const sat = (m: string) => Math.round(Number(m) * 100);
const accounts = (l: Ledger, n = 0) => l.entries[n].lines.map((x) => [x.accountCode, x.debit, x.credit]).sort((a, b) => (a[0] < b[0] ? -1 : 1));
const missing = (page: Page) => page.getByRole('region', { name: 'ยังขาดอะไร' });

test('PO view -> แปลงเป็น… -> บันทึกซื้อ: lines prefilled from the PO, vendor document number + claim period, issue, the PO shows what was received', async ({ page }) => {
  await page.goto('/'); const po = await fixtureId(page, 'poSent');
  await page.goto(`/purchases/purchase-orders/${po}`);
  await expect(page.getByText('รับวางบิลแล้ว 0/44')).toBeVisible(); // 12 + 12 + 20
  await page.getByRole('button', { name: 'แปลงเป็น…' }).click();
  const dlg = page.getByRole('dialog');
  await expect(dlg.getByLabel('เอกสารปลายทาง')).toHaveValue('PB');
  await dlg.getByRole('spinbutton', { name: 'จำนวนที่แปลงรายการที่ 1' }).fill('6');
  await dlg.getByRole('spinbutton', { name: 'จำนวนที่แปลงรายการที่ 2' }).fill('0');
  await dlg.getByRole('spinbutton', { name: 'จำนวนที่แปลงรายการที่ 3' }).fill('0');
  await dlg.getByRole('button', { name: 'สร้างบันทึกซื้อ/ค่าใช้จ่าย' }).click();
  await expect(page).toHaveURL(/\/purchases\/bills\/[^/]+\/edit$/);
  await expect(page.getByLabel('ราคาต่อหน่วยรายการ 1')).toHaveValue('890.00'); // a PO line keeps its quantity: the field is the unit price
  await expect(page.getByText(/จาก 6 ตลับ/)).toBeVisible();
  await page.getByLabel('เลขที่เอกสารของผู้ขาย').fill('INV-E2E-1');
  await page.getByLabel('งวดที่ขอคืนภาษีซื้อ').fill('2026-11');
  await expect(missing(page)).toHaveText(/ครบแล้ว/);
  await page.getByRole('button', { name: 'บันทึกและออกบันทึกซื้อ' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: /^ออกบันทึกซื้อ/ }).click();
  await expect(page.getByTestId('doc-number')).toHaveText(/^PB-\d{6}-\d{4}$/);
  const id = page.url().split('/').pop()!;
  const pb = await doc(page, 'PB', id);
  expect(pb.totals).toMatchObject({ net: '5340.00', vat: '373.80', total: '5713.80' }); // 6 x 890.00
  expect(pb.header).toMatchObject({ vendorDocNumber: 'INV-E2E-1', claimPeriod: '2026-11' });
  expect(pb.lines[0]).toMatchObject({ qty: '6', sourceLineId: expect.any(String) });
  await expect(page.getByTestId('claim-period')).toHaveText('2026-11');
  await page.goto(`/purchases/purchase-orders/${po}`);
  await expect(page.getByText('รับวางบิลแล้ว 6/44')).toBeVisible(); // the issued bill counts, the PO progress follows the chain
});

test('PB mixed VAT (pb-2 + its debit note): services VAT is input VAT, entertainment VAT is cost on 5170; the journal and the claim period are on screen', async ({ page }) => {
  await page.goto('/'); const id = await fixtureId(page, 'pbMixedVat');
  await page.goto(`${BASE}/${id}`);
  await expect(page.getByTestId('claim-period')).toHaveText('2026-10');
  await expect(page.getByText('TX-88/0412')).toBeVisible();
  await expect(page.getByText('฿12,305.00')).toBeVisible(); // 24,075.00 + the vendor's debit note 535.00 - 12,305.00 paid by pv-multi: the server's outstanding
  const ledger = await api<Ledger>(page, `/docs/PB/${id}/ledger`);
  expect(accounts(ledger)).toEqual([['1170', '1260.00', '0.00'], ['2110', '0.00', '24075.00'], ['5120', '18000.00', '0.00'], ['5150', '4500.00', '0.00'], ['5170', '315.00', '0.00']]);
  await page.getByRole('tab', { name: 'ผลต่อบัญชี' }).click();
  await expect(page.getByText('5170').first()).toBeVisible();
  await page.getByRole('tab', { name: 'เอกสารที่เกี่ยวข้อง' }).click();
  await expect(page.getByRole('link', { name: /PDN-\d{6}-\d{4}/ })).toBeVisible();
});

test('PB with vendor paperwork missing is flagged on its view and still posted', async ({ page }) => {
  await page.goto('/'); const id = await fixtureId(page, 'pbIncomplete');
  await page.goto(`${BASE}/${id}`);
  await expect(page.getByTestId('doc-incomplete')).toHaveText('เอกสารไม่ครบ');
  await expect(page.getByTestId('doc-number')).toHaveText(/^PB-/);
  const ledger = await api<Ledger>(page, `/docs/PB/${id}/ledger`);
  expect(ledger.entries).toHaveLength(1);
});

test('PB claimed late (document October, claim period December) shows its own period; a period outside the window is refused', async ({ page }) => {
  await page.goto('/'); const id = await fixtureId(page, 'pbClaimLate');
  await page.goto(`${BASE}/${id}`);
  await expect(page.getByTestId('claim-period')).toHaveText('2026-12');
  const bad = await page.evaluate(async () => {
    const r = await fetch('/bff/v1/docs/PB/compute', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ header: { partyId: 'pv-01', documentDate: '2026-10-14', claimPeriod: '2027-05' }, lines: [{ id: 'a', description: 'x', qty: '1', unit: 'งาน', unitPrice: '100.00', taxCode: 'S7' }] }) });
    return (await r.json()) as { missing: { field: string; message: string }[] };
  });
  expect(bad.missing.map((m) => m.field)).toContain('header.claimPeriod');
});

test('a vendor that is not VAT-registered cannot have input VAT on its bill: the editor says so before issue', async ({ page }) => {
  await page.goto('/'); await fixtureId(page, 'pbDraft');
  const bad = await page.evaluate(async () => {
    const r = await fetch('/bff/v1/docs/PB/compute', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ header: { partyId: 'pv-12', documentDate: '2026-10-14' }, lines: [{ id: 'a', description: 'x', qty: '1', unit: 'งาน', unitPrice: '100.00', taxCode: 'S7' }] }) });
    return (await r.json()) as { missing: { message: string }[] };
  });
  expect(bad.missing.map((m) => m.message).join(' ')).toContain('ไม่ได้จดทะเบียนภาษีมูลค่าเพิ่ม');
});

test('PB view -> บันทึกใบลดหนี้จากผู้ขาย -> lines from the bill -> partial credit -> issue: the bill outstanding drops by the PCN total, the vendor is the bill\'s', async ({ page }) => {
  await page.goto('/'); const pbId = await fixtureId(page, 'pbMixedVat');
  const before = (await doc(page, 'PB', pbId)).outstanding!;
  await page.goto(`${BASE}/${pbId}`);
  await page.getByRole('link', { name: 'บันทึกใบลดหนี้จากผู้ขาย' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'สร้างใบลดหนี้จากผู้ขาย' })).toBeVisible();
  await expect(page.getByLabel('บันทึกซื้อที่อ้างอิง')).toHaveValue(/^PB-\d{6}-\d{4} · /);
  await expect(page.getByText('ผู้ขายตามบันทึกซื้อที่อ้างอิง')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'ราคาต่อหน่วย 1', exact: true })).toHaveValue('18000.00');
  await page.getByRole('button', { name: 'ลบรายการ 2' }).click();
  await page.getByRole('textbox', { name: 'ราคาต่อหน่วย 1', exact: true }).fill('18000.01'); // more than the bill line
  await page.getByLabel('เหตุผล', { exact: true }).selectOption('PRICE_REDUCTION');
  await expect(missing(page)).toContainText('ลดหนี้เกินยอดเดิม');
  await expect(page.getByRole('button', { name: 'บันทึกและออกใบลดหนี้จากผู้ขาย' })).toBeDisabled();
  await page.getByRole('textbox', { name: 'ราคาต่อหน่วย 1', exact: true }).fill('1000.00');
  await expect(missing(page)).toHaveText(/ครบแล้ว/);
  await page.keyboard.press('Control+Enter');
  await page.getByRole('alertdialog').getByRole('button', { name: /^ออกใบลดหนี้จากผู้ขาย$/ }).click();
  await expect(page.getByTestId('doc-number')).toHaveText(/^PCN-\d{6}-\d{4}$/);
  const pcn = await doc(page, 'PCN', page.url().split('/').pop()!);
  expect(pcn.totals).toMatchObject({ net: '1000.00', vat: '70.00', total: '1070.00' });
  expect(pcn.header).toMatchObject({ refDocId: pbId, partyId: 'pv-03' });
  expect(sat((await doc(page, 'PB', pbId)).outstanding!)).toBe(sat(before) - sat(pcn.totals.total));
  await page.getByRole('tab', { name: 'เอกสารที่เกี่ยวข้อง' }).click();
  await expect(page.getByRole('link', { name: /PB-\d{6}-\d{4}/ }).first()).toBeVisible(); // the chain also reaches pb-po through pv-multi
});

test('a settled bill (pv-pay1 pays pb-1 after pcn-1) cannot be cancelled: the settlement lock disables the button', async ({ page }) => {
  await page.goto('/'); const id = await fixtureId(page, 'pb1Settled'); // pb-1 has pcn-1 AND pv-pay1
  await page.goto(`${BASE}/${id}`);
  await expect(page.getByRole('button', { name: 'ยกเลิกเอกสาร' })).toBeDisabled(); // pv-pay1 paid it: cancel the voucher first
  expect((await doc(page, 'PB', id)).status).toBe('settled');
});

test('an UNPAID bill with a live vendor credit note cannot be cancelled (the note, not a payment, stops it); the operator cannot cancel or record vendor notes at all', async ({ page }) => {
  await page.goto('/'); await fixtureId(page, 'pbIssuedUnpaid');
  const id = await page.evaluate(async () => { // a fresh bill and a credit note on it: no voucher, so only the live note can be what refuses the cancel
    const h = { 'content-type': 'application/json' };
    const make = async (type: string, body: unknown) => { const d = await (await fetch(`/bff/v1/docs/${type}`, { method: 'POST', headers: h, body: JSON.stringify(body) })).json(); return (await (await fetch(`/bff/v1/docs/${type}/${d.id}/issue`, { method: 'POST', headers: h, body: JSON.stringify({ version: d.version }) })).json()) as { id: string };
    };
    const pb = await make('PB', { header: { partyId: 'pv-03', documentDate: '2026-10-14' }, lines: [{ id: 'l1', description: 'x', qty: '1', unit: 'งาน', unitPrice: '1000.00', taxCode: 'S7', expenseCategory: 'services' }] });
    await make('PCN', { header: { documentDate: '2026-10-14', refDocId: pb.id, reasonCode: 'PRICE_REDUCTION' }, lines: [{ id: 'c1', description: 'x', qty: '1', unit: 'งาน', unitPrice: '100.00', taxCode: 'S7', sourceLineId: 'l1' }] });
    return pb.id;
  });
  await page.goto(`${BASE}/${id}`);
  await expect(page.getByRole('button', { name: 'ยกเลิกเอกสาร' })).toBeEnabled(); // not settled: the button works, the server refuses
  await page.getByRole('button', { name: 'ยกเลิกเอกสาร' }).click();
  const dlg = page.getByRole('alertdialog');
  await dlg.getByRole('combobox').click();
  await page.getByRole('option').first().click();
  await dlg.getByRole('button', { name: 'ยืนยันยกเลิก' }).click();
  await expect(dlg.getByText(/มีใบลดหนี้\/ใบเพิ่มหนี้อ้างอิงอยู่/)).toBeVisible();
  expect((await doc(page, 'PB', id)).status).toBe('issued');
  await page.goto(`${BASE}/${id}?role=operator`);
  await expect(page.getByRole('button', { name: 'ยกเลิกเอกสาร' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'บันทึกใบลดหนี้จากผู้ขาย' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'บันทึกใบเพิ่มหนี้จากผู้ขาย' })).toBeDisabled();
});

test('revising a bill keeps its number, posts a reversal + correction, and refuses a vendor change', async ({ page }) => {
  await page.goto('/'); const id = await fixtureId(page, 'pbCapex');
  await page.goto(`${BASE}/${id}`);
  const number = await page.getByTestId('doc-number').innerText();
  await page.getByRole('link', { name: 'แก้ไข' }).click();
  await page.getByLabel('เลขที่เอกสารของผู้ขาย').fill('IT-2026-0093-R');
  await page.getByRole('button', { name: 'บันทึกการแก้ไข' }).click();
  await page.getByRole('alertdialog', { name: /แผนการแก้ไข/ }).getByRole('button', { name: 'ยืนยันทั้งหมด' }).click();
  await expect(page.getByTestId('doc-number')).toHaveText(number);
  await expect(page.getByText('IT-2026-0093-R')).toBeVisible();
  const ledger = await api<Ledger>(page, `/docs/PB/${id}/ledger`);
  expect(ledger.entries.map((e) => e.kind)).toEqual(['original', 'reversal', 'correction']);
  expect(accounts(ledger, 2)).toEqual([['1170', '2240.00', '0.00'], ['1210', '32000.00', '0.00'], ['2110', '0.00', '34240.00']]); // the notebook is capitalised, its VAT claimed
});

test('non-VAT company: the vendor\'s VAT 70.00 is cost - AP 1,070.00, 5170 carries the VAT, 1170 is untouched, and no claim period is asked', async ({ page }) => {
  await page.goto('/?company=nonvat'); const id = await fixtureId(page, 'npbVatToCost');
  await page.goto(`${BASE}/${id}`);
  await expect(page.getByTestId('doc-number')).toHaveText(/^PB-/);
  await expect(page.getByText('฿1,070.00').first()).toBeVisible();
  await expect(page.getByTestId('claim-period')).toHaveCount(0);
  const pb = await doc(page, 'PB', id);
  expect(pb.totals).toMatchObject({ net: '1000.00', vat: '70.00', total: '1070.00' });
  const ledger = await api<Ledger>(page, `/docs/PB/${id}/ledger`);
  expect(accounts(ledger)).toEqual([['2110', '0.00', '1070.00'], ['5120', '1000.00', '0.00'], ['5170', '70.00', '0.00']]);
  await page.goto(`${BASE}/new?company=nonvat`);
  await expect(page.getByLabel('งวดที่ขอคืนภาษีซื้อ')).toHaveCount(0);
});

test('the vendor open-items tab lists the vendor\'s bills with the server total', async ({ page }) => {
  await page.goto('/'); await fixtureId(page, 'pbMixedVat');
  await page.goto('/master/vendors/pv-03');
  await page.getByRole('tab', { name: 'ยอดค้าง' }).click();
  const panel = page.getByRole('tabpanel', { name: 'ยอดค้าง' });
  await expect(panel.getByRole('link', { name: /PB-\d{6}-\d{4}/ })).toHaveCount(2); // pb-2 and pb-po
  await expect(panel.getByRole('status')).toContainText('฿13,338.00'); // pb-2 24,610.00 - 12,305.00 paid by pv-multi + pb-po 2,033.00 - 1,000.00 paid
});

test('non-VAT company: a new bill with the vendor\'s 7 % VAT shows AP 1,070.00 in the totals before issue and posts the VAT as cost', async ({ page }) => {
  await page.goto('/?company=nonvat'); await fixtureId(page, 'npbVatToCost');
  await page.goto(`${BASE}/new`);
  await page.getByRole('combobox', { name: 'ผู้ขาย' }).fill('ร้านวัสดุ');
  await page.getByRole('option').first().waitFor();
  await page.keyboard.press('Enter');
  await page.getByRole('combobox', { name: 'รายการ 1', exact: true }).fill('ปูนซีเมนต์');
  await page.getByRole('textbox', { name: 'จำนวนเงินรายการ 1' }).fill('1000.00');
  await page.getByRole('combobox', { name: 'ภาษีรายการ 1' }).selectOption('S7'); // the vendor's tax invoice carries VAT; this company cannot claim it
  await page.getByRole('combobox', { name: 'หมวดค่าใช้จ่ายรายการ 1' }).selectOption('supplies');
  await expect(missing(page)).toHaveText(/ครบแล้ว/);
  const totals = page.getByRole('region', { name: 'ยอดรวม' });
  await expect(totals).toContainText('70.00');
  await expect(totals).toContainText('1,070.00');
  await page.keyboard.press('Control+Enter');
  await page.getByRole('alertdialog').getByRole('button', { name: /^ออกบันทึกซื้อ/ }).click();
  await expect(page.getByTestId('doc-number')).toHaveText(/^PB-\d{6}-\d{4}$/);
  const id = page.url().split('/').pop()!;
  const ledger = await api<Ledger>(page, `/docs/PB/${id}/ledger`);
  expect(accounts(ledger)).toEqual([['2110', '0.00', '1070.00'], ['5160', '1000.00', '0.00'], ['5170', '70.00', '0.00']]);
});

test('PB draft: the editor opens with the vendor paperwork filled and the bill issues once complete', async ({ page }) => {
  await page.goto('/'); const id = await fixtureId(page, 'pbDraft');
  await page.goto(`${BASE}/${id}/edit`);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('บันทึกซื้อ/ค่าใช้จ่าย');
  await expect(page.getByLabel('เลขที่เอกสารของผู้ขาย')).toHaveValue('FP-1180');
  await expect(page.getByLabel('งวดที่ขอคืนภาษีซื้อ')).toHaveValue('2026-10'); // the document month until one is chosen
  await expect(page.getByRole('checkbox', { name: /เอกสารครบ/ })).toBeChecked();
  await expect(page.getByRole('combobox', { name: 'หมวดค่าใช้จ่ายรายการ 1' })).toHaveValue('advertising');
  await expect(missing(page)).toHaveText(/ครบแล้ว/);
  await page.getByRole('button', { name: 'บันทึกและออกบันทึกซื้อ' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: /^ออกบันทึกซื้อ/ }).click();
  await expect(page).toHaveURL(new RegExp(`${BASE}/${id}$`));
  await expect(page.getByTestId('doc-number')).toHaveText(/^PB-\d{6}-\d{4}$/);
  await expect(page.getByTestId('claim-period')).toHaveText('2026-10'); // filed in the document month at issue
});
