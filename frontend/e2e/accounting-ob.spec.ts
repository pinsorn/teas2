import { expect, test, type Page } from '@playwright/test';
import { axeClean } from './helpers/axe';
import { fixtureId } from './helpers/fixtures';
import { screenContract } from './helpers/screen-contract';

const BASE = '/accounting/opening-balances';
const STATES = ['empty', 'loading', 'error', 'forbidden'] as const;
const shot = async (page: Page, name: string) => { if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/${name}.png`, fullPage: true }); };

// opening balances are the accountant's (§3.1): the operator is forbidden on every screen
screenContract({ name: 'OB list', path: BASE, heading: 'ยอดยกมา', company: 'both', states: [...STATES], forbiddenRole: 'operator' });
screenContract({ name: 'OB view (non-VAT, issued)', path: async (p) => `${BASE}/${await fixtureId(p, 'obIssued')}`, heading: /OB-\d{6}-\d{4}/, company: 'nonvat', otherCompany: 'not-found', states: ['loading', 'error', 'forbidden'], forbiddenRole: 'operator' });
screenContract({ name: 'OB wizard (new)', path: `${BASE}/new`, heading: 'ตั้งยอดยกมา', company: 'both', states: ['loading', 'error'], forbiddenRole: 'operator' });
screenContract({ name: 'OB wizard (VAT draft)', path: async (p) => `${BASE}/${await fixtureId(p, 'obDraft')}/edit`, heading: 'ตั้งยอดยกมา', company: 'vat', otherCompany: 'not-found', states: ['loading', 'error'] });

test.beforeEach(async ({ page }) => { await page.goto('/'); await page.evaluate(() => localStorage.clear()); await page.reload(); });

const api = <T,>(page: Page, path: string) => page.evaluate(async (p) => (await fetch(`/bff/v1${p}`)).json(), path) as Promise<T>;
const send = (page: Page, method: string, path: string, body: unknown) => page.evaluate(async ([m, p, b]) => {
  const r = await fetch(`/bff/v1${p as string}`, { method: m as string, headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
  return { status: r.status, json: await r.json().catch(() => undefined) } as { status: number; json: Record<string, unknown> & { code?: string; title?: string; id?: string; version?: number } };
}, [method, path, body] as const);
type Ledger = { entries: { kind: string; date: string; lines: { accountCode: string; debit: string; credit: string; partyName?: string; rule: string }[] }[] };

test('the wizard on the VAT draft: every step, then the check step states the ties and the 3900 difference; issue posts it at the cut-off', async ({ page }) => {
  await page.goto('/'); const id = await fixtureId(page, 'obDraft');
  await page.goto(`${BASE}/${id}/edit`);
  await expect(page.getByRole('heading', { level: 1, name: 'ตั้งยอดยกมา' })).toBeVisible();
  await expect(page.locator('#ob-cutoff')).toHaveValue('2026-06-30');
  await shot(page, 'ob-step1');
  for (const [n, name] of [[2, 'เงินสดและธนาคาร'], [3, 'ลูกหนี้/เจ้าหนี้คงค้างรายฉบับ'], [4, 'ทะเบียนสินทรัพย์'], [5, 'เงินเดือนสะสมของปี']] as const) {
    await page.getByRole('button', { name: new RegExp(`^${n} ${name.replace('/', '\\/')}`) }).click();
    await expect(page.getByRole('heading', { level: 2, name: new RegExp(`ขั้นที่ ${n} จาก 6`) })).toBeVisible();
    if (n === 2) { await expect(page.getByRole('textbox', { name: 'ยอด statement ของบัญชี 1' })).toHaveValue('20000.00'); await shot(page, 'ob-step2-bank'); }
    if (n === 3) { await expect(page.getByRole('combobox', { name: /^ประเภทรายการที่/ })).toHaveCount(3); await shot(page, 'ob-step3-items'); }
  }
  await page.getByRole('button', { name: /^6 ตรวจสอบและบันทึก/ }).click();
  await expect(page.getByTestId('ob-plug')).toContainText('28,500.00');
  await expect(page.getByTestId('ob-plug')).toContainText('เครดิตส่วนเกินทุนยอดยกมา (3900)');
  for (const key of ['AR', 'AP', 'BANK:1122']) await expect(page.getByTestId(`ob-tie-${key}`)).toContainText('ตรงกัน');
  await expect(page.getByRole('region', { name: 'รายการบัญชีที่จะลง' })).toContainText('ผลต่างยกไปส่วนเกินทุนยอดยกมา');
  await shot(page, 'ob-review');
  await axeClean(page);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true); // no horizontal page scroll on a phone
  await shot(page, 'ob-review-mobile');
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByRole('button', { name: 'บันทึกยอดยกมา' }).click();
  await expect(page.getByTestId('doc-number')).toHaveText(/^OB-\d{6}-\d{4}$/);
  const docId = page.url().split('/').pop()!;
  await expect(page.getByTestId('ob-summary')).toContainText('TI-2026-0001');
  await shot(page, 'ob-issued-view');
  // one journal at the cut-off: per-party receivable lines, the bank line = statement + deposit in transit, the plug
  const l = await api<Ledger>(page, `/docs/OB/${docId}/ledger`);
  expect(l.entries).toHaveLength(1);
  expect(l.entries[0].date).toBe('2026-06-30');
  expect(l.entries[0].lines.filter((x) => x.accountCode === '1130').map((x) => x.debit).sort()).toEqual(['6000.00', '9000.00']);
  expect(l.entries[0].lines.find((x) => x.accountCode === '1122')).toMatchObject({ debit: '21500.00' });
  expect(l.entries[0].lines.find((x) => x.accountCode === '3900')).toMatchObject({ credit: '28500.00', rule: 'ผลต่างยกไปส่วนเกินทุนยอดยกมา' });
  // the bank account is in go-live now: a second opening of it is refused with the cause
  const second = await send(page, 'POST', '/docs/OB/compute', { header: { documentDate: '2026-06-30' }, lines: [], opening: { openItems: [], assets: [], payrollYtd: [], bank: [{ accountId: 'ba-scb', statement: '1.00', inTransit: [] }] } });
  expect(second.status).toBe(200);
  expect((second.json as unknown as { missing: { code?: string }[] }).missing.some((m) => m.code === 'ob.already_exists')).toBe(true);
});

test('an issued opening item is settled by a receipt; the batch is then locked with the exit, and cancelling the receipt frees it', async ({ page }) => {
  await page.goto('/'); const draft = await fixtureId(page, 'obDraft');
  const d = await api<{ version: number }>(page, `/docs/OB/${draft}`);
  expect((await send(page, 'POST', `/docs/OB/${draft}/issue`, { version: d.version })).status).toBe(200);
  const items = await api<{ items: { id: string; type: string; number: string; outstanding: string }[] }>(page, '/docs/open-items?partyId=pc-01&types=TI,IV,OB');
  const item = items.items.find((i) => i.type === 'OB')!;
  expect(item).toMatchObject({ number: 'TI-2026-0001 (ยกมา)', outstanding: '9000.00' });
  const rc = await send(page, 'POST', '/docs/RC', { header: { partyId: 'pc-01', documentDate: '2026-10-14' }, lines: [], allocations: [{ targetId: item.id, targetType: 'OB', amount: '4000.00' }] });
  expect(rc.status).toBe(201);
  const issued = await send(page, 'POST', `/docs/RC/${rc.json.id}/issue`, { version: rc.json.version });
  expect(issued.status).toBe(200);
  const plain = await api<{ items: { type: string }[] }>(page, '/docs/open-items?partyId=pc-01&types=TI,IV'); // the FN3 form asks without OB: it never sees an opening item
  expect(plain.items.some((i) => i.type === 'OB')).toBe(false);
  const after = await api<{ items: { id: string; outstanding: string }[] }>(page, '/docs/open-items?partyId=pc-01&types=TI,IV,OB');
  expect(after.items.find((i) => i.id === item.id)!.outstanding).toBe('5000.00');
  await page.goto(`${BASE}/${draft}`);
  const banner = page.getByRole('status', { name: /ล็อก/ }).first();
  await expect(banner).toContainText('ถูกชำระ/ปรับปรุงด้วย RC-');
  await expect(page.getByRole('button', { name: 'ยกเลิกเอกสาร' })).toBeDisabled();
  await shot(page, 'ob-locked');
  await banner.getByRole('button', { name: /^ยกเลิก RC-/ }).click(); // the exit leads to the receipt that settled the item
  await expect(page).toHaveURL(/\/sales\/receipts\/[^/]+$/);
  await page.goBack();
  const cancel = await send(page, 'POST', `/docs/OB/${draft}/cancel`, { version: (await api<{ version: number }>(page, `/docs/OB/${draft}`)).version, reasonCode: 'OTHER', reasonText: 'x' });
  expect(cancel.status).toBe(409);
  expect(cancel.json.code).toBe('ob.locked');
  expect(cancel.json.title).toContain('ยกเลิก RC-');
  // the exit: cancel the receipt, then the batch can go
  const rcDoc = await api<{ version: number }>(page, `/docs/RC/${rc.json.id}`);
  expect((await send(page, 'POST', `/docs/RC/${rc.json.id}/cancel`, { version: rcDoc.version, reasonCode: 'OTHER', reasonText: 'ทดสอบ' })).status).toBe(200);
  const doc2 = await api<{ version: number }>(page, `/docs/OB/${draft}`);
  expect((await send(page, 'POST', `/docs/OB/${draft}/cancel`, { version: doc2.version, reasonCode: 'OTHER', reasonText: 'ทดสอบ' })).status).toBe(200);
});

test('the non-VAT company\'s opening: its journal at 2025-12-31, receivables and the payable tie, the 3900 difference is stated', async ({ page }) => {
  await page.goto('/'); const id = await fixtureId(page, 'obIssued');
  await page.goto(`${BASE}/${id}?company=nonvat`);
  await expect(page.getByTestId('doc-number')).toHaveText(/^OB-\d{6}-\d{4}$/);
  await expect(page.getByTestId('ob-summary')).toContainText('IV-2025-0101');
  const l = await api<Ledger>(page, `/docs/OB/${id}/ledger`);
  expect(l.entries[0].date).toBe('2025-12-31');
  expect(l.entries[0].lines.find((x) => x.accountCode === '3900')).toBeTruthy();
  const dr = l.entries[0].lines.reduce((a, x) => a + Math.round(Number(x.debit) * 100), 0), cr = l.entries[0].lines.reduce((a, x) => a + Math.round(Number(x.credit) * 100), 0);
  expect(dr).toBe(cr);
  await axeClean(page);
});

test('the receipt editor lists an opening item beside the invoices and settles it; a phone has no horizontal scroll', async ({ page }) => {
  await page.goto('/'); const draft = await fixtureId(page, 'obDraft');
  const d = await api<{ version: number }>(page, `/docs/OB/${draft}`);
  expect((await send(page, 'POST', `/docs/OB/${draft}/issue`, { version: d.version })).status).toBe(200);
  await page.goto('/sales/receipts/new');
  await page.getByRole('combobox', { name: 'ลูกค้า' }).fill('นาวา');
  await page.getByRole('option').first().waitFor();
  await page.keyboard.press('Enter');
  const panel = page.getByRole('region', { name: 'รายการที่รับชำระ' });
  const row = panel.getByRole('row', { name: /TI-2026-0001 \(ยกมา\)/ });
  await expect(row).toBeVisible();
  await row.getByRole('checkbox').check();
  await expect(row.getByLabel(/จำนวนรับชำระ/)).toHaveValue('9000.00');
  await shot(page, 'ob-receipt-picks-opening-item');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await shot(page, 'ob-receipt-mobile');
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.keyboard.press('Control+Enter');
  await page.getByRole('alertdialog').getByRole('button', { name: /^ออกใบเสร็จรับเงิน$/ }).click();
  await expect(page.getByTestId('doc-number')).toHaveText(/^RC-\d{6}-\d{4}$/);
  const after = await api<{ items: { type: string; outstanding: string }[] }>(page, '/docs/open-items?partyId=pc-01&types=TI,IV,OB');
  expect(after.items.find((i) => i.type === 'OB')).toBeUndefined(); // paid in full: nothing left to settle
});
