import { expect, test, type Page } from '@playwright/test';
import { fixtureId } from './helpers/fixtures';

const BASE = '/purchases/expense-claims';
const api = <T,>(page: Page, path: string) => page.evaluate(async (p) => (await fetch(`/bff/v1${p}`)).json(), path) as Promise<T>;
const post = (page: Page, path: string, body: unknown) => page.evaluate(async ([p, b]) => {
  const r = await fetch(`/bff/v1${p as string}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}, [path, body] as const);
type DocJson = { id: string; number?: string; status: string; version: number; outstanding?: string; approval?: { submittedBy: { name: string }; approvedBy?: { name: string } }; allocations?: { targetId: string }[] };
const doc = (page: Page, type: string, id: string) => api<DocJson>(page, `/docs/${type}/${id}`);
const idOf = (page: Page) => page.url().split('/').filter(Boolean).pop()!.replace(/\?.*$/, '');
const pickEmployee = async (page: Page, q: string) => {
  await page.getByRole('combobox', { name: 'พนักงาน' }).fill(q);
  await page.getByRole('listbox').getByRole('option').first().waitFor();
  await page.keyboard.press('Enter');
};

/** The operator files a claim and submits it for approval (the editor's primary action is "ส่งอนุมัติ" for someone who cannot approve). Returns the pending claim's id. */
async function operatorSubmits(page: Page, description: string, amount: string): Promise<string> {
  await page.goto(`${BASE}/new?role=operator`);
  await pickEmployee(page, 'สมศรี');
  await page.getByRole('combobox', { name: 'รายการ 1', exact: true }).fill(description);
  await page.getByRole('textbox', { name: 'จำนวนเงินรายการ 1' }).fill(amount);
  await expect(page.getByRole('region', { name: 'ยังขาดอะไร' })).toHaveText(/ครบแล้ว/);
  await page.getByRole('button', { name: 'ส่งอนุมัติ' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'ส่งอนุมัติ' }).click();
  await expect(page).toHaveURL(new RegExp(`${BASE}/(?!new)[^/?]+$`));
  const id = idOf(page);
  await expect.poll(async () => (await doc(page, 'EX', id)).status).toBe('pending');
  return id;
}

test('operator submits -> accountant approves and issues in one action -> EX -> PV pays it: EX outstanding 0, status settled', async ({ page }) => {
  const id = await operatorSubmits(page, 'ค่าที่จอดรถลูกค้า', '120.00');
  let ex = await doc(page, 'EX', id);
  expect(ex.number).toBeUndefined(); // no number, nothing posted while it waits
  await expect(page.getByRole('button', { name: 'อนุมัติ', exact: true })).toBeDisabled(); // the operator may not approve
  expect((await post(page, `/docs/EX/${id}/issue`, { version: ex.version })).json).toMatchObject({ code: 'approval.pending' }); // the gate is the server's
  expect((await post(page, `/docs/EX/${id}/approve-and-issue`, { version: ex.version })).status).toBe(403); // one action only for a person who holds both rights

  await page.goto(`${BASE}/${id}?role=accountant`);
  await fixtureId(page, 'exDraft');
  expect((await api<{ entries: unknown[] }>(page, `/docs/EX/${id}/ledger`)).entries).toHaveLength(0); // nothing posted while it waits
  await page.getByRole('button', { name: 'อนุมัติและออก' }).click();
  await expect.poll(async () => (await doc(page, 'EX', id)).status).toBe('issued');
  ex = await doc(page, 'EX', id);
  expect(ex.number).toMatch(/^EX-\d{6}-\d{4}$/);
  expect(ex.approval?.approvedBy?.name).toBeTruthy();
  const all = await api<{ items: { id: string; number?: string }[] }>(page, '/docs/EX?limit=200');
  expect(all.items.filter((d) => d.number === ex.number)).toHaveLength(1); // the number was allocated once
  await page.getByRole('tab', { name: 'กิจกรรม' }).click();
  for (const a of ['ส่งอนุมัติ', 'อนุมัติ', 'ออกเอกสาร']) await expect(page.getByRole('listitem').filter({ hasText: new RegExp(`^${a}`) }).first()).toBeVisible();

  await page.getByRole('button', { name: 'แปลงเป็น…' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'สร้างใบสำคัญจ่าย' }).click();
  await expect(page).toHaveURL(/\/purchases\/payment-vouchers\/[^/]+\/edit$/);
  await expect(page.getByRole('region', { name: 'ยอดรวม' })).toContainText('120.00');
  await page.getByRole('button', { name: 'บันทึกและออกใบสำคัญจ่าย' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: /^ออกใบสำคัญจ่าย/ }).click();
  await expect(page.getByTestId('doc-number')).toHaveText(/^PV-\d{6}-\d{4}$/);
  expect(await doc(page, 'EX', id)).toMatchObject({ status: 'settled', outstanding: '0.00' });
});

test('approve, then issue from the approved state; editing an approved claim returns it to draft and it must be sent again', async ({ page }) => {
  const id = await operatorSubmits(page, 'ค่าส่งเอกสาร', '90.00');
  await page.goto(`${BASE}/${id}?role=accountant`);
  await page.getByRole('button', { name: 'อนุมัติ', exact: true }).click();
  await expect.poll(async () => (await doc(page, 'EX', id)).status).toBe('approved');
  expect((await doc(page, 'EX', id)).number).toBeUndefined();
  // editing it sends it back to draft
  await page.getByRole('link', { name: 'บันทึกและออก…' }).click();
  await expect(page).toHaveURL(new RegExp(`${BASE}/${id}/edit$`));
  await page.getByRole('textbox', { name: 'จำนวนเงินรายการ 1' }).fill('95.00');
  await expect.poll(async () => (await doc(page, 'EX', id)).status, { timeout: 15_000 }).toBe('draft');
  expect((await post(page, `/docs/EX/${id}/issue`, { version: (await doc(page, 'EX', id)).version })).json).toMatchObject({ code: 'approval.required' });
  // sent again, approved, issued from the approved state (the editor's own issue)
  await page.goto(`${BASE}/${id}?role=operator`);
  await page.getByRole('button', { name: 'ส่งอนุมัติ' }).click();
  await expect.poll(async () => (await doc(page, 'EX', id)).status).toBe('pending');
  await page.goto(`${BASE}/${id}?role=accountant`);
  await page.getByRole('button', { name: 'อนุมัติ', exact: true }).click();
  await expect.poll(async () => (await doc(page, 'EX', id)).status).toBe('approved');
  await page.getByRole('link', { name: 'บันทึกและออก…' }).click();
  await page.getByRole('button', { name: 'บันทึกและออกใบเบิกค่าใช้จ่าย' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: /^ออก/ }).click();
  await expect(page.getByTestId('doc-number')).toHaveText(/^EX-\d{6}-\d{4}$/);
  expect(await doc(page, 'EX', id)).toMatchObject({ status: 'issued', outstanding: '95.00' });
});

test('send back needs a reason and lands on the timeline of the draft', async ({ page }) => {
  const id = await operatorSubmits(page, 'ค่าถ่ายเอกสาร', '40.00');
  await page.goto(`${BASE}/${id}?role=accountant`);
  await page.getByRole('button', { name: 'ส่งกลับแก้ไข' }).click();
  const dlg = page.getByRole('alertdialog');
  await expect(dlg.getByRole('button', { name: 'ส่งกลับแก้ไข' })).toBeDisabled();
  await dlg.getByLabel('เหตุผลที่ส่งกลับ').fill('แนบใบเสร็จไม่ครบ');
  await dlg.getByRole('button', { name: 'ส่งกลับแก้ไข' }).click();
  await expect.poll(async () => (await doc(page, 'EX', id)).status).toBe('draft');
  await page.getByRole('tab', { name: 'กิจกรรม' }).click();
  await expect(page.getByText('ส่งกลับแก้ไข: แนบใบเสร็จไม่ครบ')).toBeVisible();
});

test('the gate on every issue path: a direct issue of an EX draft is refused; a PV above 50,000.00 needs approval, one below issues directly', async ({ page }) => {
  await page.goto('/?role=accountant');
  await fixtureId(page, 'exDraft'); // the mock worker is up
  const line = (id: string, price: string) => ({ id, description: 'ค่าใช้จ่าย', qty: '1', unit: 'ครั้ง', unitPrice: price, taxCode: 'EX', expenseCategory: 'services' });
  const mk = async (type: string, partyId: string, price: string) => (await post(page, `/docs/${type}`, { header: { partyId, documentDate: '2026-10-14' }, lines: [line('l1', price)] })).json as DocJson;
  const ex = await mk('EX', 'emp-02', '300.00');
  const refused = await post(page, `/docs/EX/${ex.id}/issue`, { version: ex.version });
  expect(refused).toMatchObject({ status: 422, json: { code: 'approval.required' } });
  expect((await doc(page, 'EX', ex.id)).status).toBe('draft');

  const big = await mk('PV', 'pv-01', '50000.01'), edge = await mk('PV', 'pv-01', '50000.00');
  expect((await post(page, `/docs/PV/${big.id}/issue`, { version: big.version })).json).toMatchObject({ code: 'approval.required' });
  expect((await post(page, `/docs/PV/${edge.id}/issue`, { version: edge.version })).json).toMatchObject({ status: 'issued' });
  const sub = await post(page, `/docs/PV/${big.id}/submit`, { version: big.version });
  expect(sub.json).toMatchObject({ status: 'pending' });
  const issued = await post(page, `/docs/PV/${big.id}/approve-and-issue`, { version: sub.json.version });
  expect(issued.json).toMatchObject({ status: 'issued' });
  expect(issued.json.number).toMatch(/^PV-\d{6}-\d{4}$/);
  // a bill has no policy: QuickBill-created and direct PBs are untouched
  const pb = await post(page, '/docs/PB', { header: { partyId: 'pv-01', documentDate: '2026-10-14' }, lines: [line('b1', '100.00')] });
  expect((await post(page, `/docs/PB/${pb.json.id}/issue`, { version: pb.json.version })).json).toMatchObject({ status: 'issued' });
});

test('an approved claim opened to issue is simply issued; once it is edited the editor treats it as a draft again (approve-and-issue, never a stale "issue")', async ({ page }) => {
  await page.goto('/?role=accountant'); const id = await fixtureId(page, 'exApproved');
  await page.goto(`${BASE}/${id}/edit`);
  await expect(page.getByRole('textbox', { name: 'จำนวนเงินรายการ 1' })).toHaveValue('2500.00');
  await page.waitForTimeout(2500); // longer than the autosave delay: opening it must not send it back to draft
  expect((await doc(page, 'EX', id)).status).toBe('approved');
  await page.getByRole('textbox', { name: 'จำนวนเงินรายการ 1' }).fill('2600.00');
  await expect(page.getByRole('region', { name: 'ยอดรวม' })).toContainText('2,782.00'); // 2,600.00 + VAT 182.00
  await page.getByRole('button', { name: 'บันทึกและออกใบเบิกค่าใช้จ่าย' }).click();
  await expect(page.getByRole('alertdialog')).toContainText('อนุมัติและออกเอกสารในครั้งเดียว');
  await page.getByRole('alertdialog').getByRole('button', { name: /^ออก/ }).click();
  await expect(page.getByTestId('doc-number')).toHaveText(/^EX-\d{6}-\d{4}$/);
  expect(await doc(page, 'EX', id)).toMatchObject({ status: 'issued', outstanding: '2782.00' });
});
