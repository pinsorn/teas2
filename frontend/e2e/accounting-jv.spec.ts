import { expect, test, type Page } from '@playwright/test';
import { axeClean } from './helpers/axe';
import { fixtureId } from './helpers/fixtures';
import { screenContract } from './helpers/screen-contract';

const BASE = '/accounting/journal-vouchers';
const STATES = ['empty', 'loading', 'error', 'forbidden'] as const;
const shot = async (page: Page, name: string) => { if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/${name}.png`, fullPage: true }); };

// JV is accountant-only (§3.1): the operator is forbidden on every screen; the ledger is read with ledger.read
screenContract({ name: 'JV list', path: BASE, heading: 'ใบสำคัญทั่วไป', company: 'both', states: [...STATES], forbiddenRole: 'operator' });
screenContract({ name: 'JV view', path: async (p) => `${BASE}/${await fixtureId(p, 'jvAccrual')}`, heading: /JV-\d{6}-\d{4}/, company: 'vat', otherCompany: 'not-found', states: ['loading', 'error', 'forbidden'], forbiddenRole: 'operator' });
screenContract({ name: 'JV new', path: `${BASE}/new`, heading: 'สร้างใบสำคัญทั่วไป', company: 'both', states: ['loading', 'error'] });
screenContract({ name: 'journals (general journal)', path: '/accounting/journals', heading: 'สมุดรายวัน', company: 'both', states: [...STATES], forbiddenRole: 'operator' });

test.beforeEach(async ({ page }) => { await page.goto('/'); await page.evaluate(() => localStorage.clear()); await page.reload(); });

const api = <T,>(page: Page, path: string) => page.evaluate(async (p) => (await fetch(`/bff/v1${p}`)).json(), path) as Promise<T>;
const post = (page: Page, path: string, body: unknown) => page.evaluate(async ([p, b]) => {
  const r = await fetch(`/bff/v1${p as string}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
  return { status: r.status, json: await r.json().catch(() => undefined) } as { status: number; json: { code?: string; title?: string } };
}, [path, body] as const);
type Ledger = { entries: { kind: string; date: string; lines: { accountCode: string; debit: string; credit: string }[] }[] };
const lines = (l: Ledger, n = 0) => l.entries[n].lines.map((x) => [x.accountCode, x.debit, x.credit]);

/** Types an account code into line n's account cell and picks it with Enter (the first match). */
async function pickAccount(page: Page, n: number, code: string) {
  const cell = page.getByRole('combobox', { name: `บัญชีรายการ ${n}` });
  await cell.fill(code);
  await page.getByRole('listbox').getByRole('option').first().waitFor();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('textbox', { name: `คำอธิบายรายการ ${n}` })).toBeFocused();
}

test('create a 2-line JV with Tab / Enter only, issue it, then กลับรายการ from the ledger tab: the reversal nets it to zero and the original is final', async ({ page }) => {
  await page.goto(`${BASE}/new`);
  await expect(page.getByRole('heading', { level: 1, name: 'สร้างใบสำคัญทั่วไป' })).toBeVisible();
  await expect(page.getByLabel('วันที่เอกสาร')).not.toHaveValue('');
  // line 1: Dr 5110 2,500.00 (account, Enter, note, Enter, debit, Enter, credit left empty, Enter)
  await page.getByRole('combobox', { name: 'บัญชีรายการ 1' }).click();
  await pickAccount(page, 1, '5110');
  await page.keyboard.type('ค่าเช่าสำนักงาน ต.ค.');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('textbox', { name: 'เดบิตรายการ 1' })).toBeFocused();
  await page.keyboard.type('2500');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('textbox', { name: 'เครดิตรายการ 1' })).toBeFocused();
  await page.keyboard.press('Enter');
  // line 2: Cr 2120 2,500.00, reached with Enter; the account is chosen by Tab after typing the whole code
  await expect(page.getByRole('combobox', { name: 'บัญชีรายการ 2' })).toBeFocused();
  await page.keyboard.type('2120');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('combobox', { name: 'บัญชีรายการ 2' })).toHaveValue(/^2120 /);
  await page.keyboard.type('ค้างจ่ายค่าเช่า');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab'); // past the debit
  await page.keyboard.type('2500');
  const balance = page.getByRole('region', { name: 'ยอดรวมใบสำคัญ' });
  await expect(balance.getByTestId('jv-debit')).toHaveText('2,500.00');
  await expect(balance.getByTestId('jv-credit')).toHaveText('2,500.00');
  await expect(balance.getByTestId('jv-diff')).toHaveText('0.00');
  await expect(balance).toContainText('ยอดเดบิตและเครดิตเท่ากัน');
  await shot(page, 'jv-editor');
  await axeClean(page);
  await page.getByRole('button', { name: 'บันทึกและออกใบสำคัญทั่วไป' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: /^ออก/ }).click();
  await expect(page.getByTestId('doc-number')).toHaveText(/^JV-\d{6}-\d{4}$/);
  const id = page.url().split('/').pop()!;
  await page.getByRole('tab', { name: 'ผลต่อบัญชี' }).click();
  const tab = page.getByRole('tabpanel');
  await expect(tab).toContainText('5110');
  await expect(tab).toContainText('2120');
  await shot(page, 'jv-ledger');
  await tab.getByRole('button', { name: 'กลับรายการ' }).click();
  const dlg = page.getByRole('alertdialog');
  await dlg.getByLabel('เหตุผล (ไม่บังคับ)').fill('ลงผิดงวด');
  await shot(page, 'jv-reverse-dialog');
  await dlg.getByRole('button', { name: 'กลับรายการ', exact: true }).click();
  // the original reads final now: the banner names the reversing voucher, edit / cancel are refused
  const banner = page.getByRole('status', { name: /ล็อก/ }).first();
  await expect(banner).toContainText('กลับรายการแล้วโดย JV-');
  await expect(banner).toContainText('แก้ไขหรือยกเลิกไม่ได้');
  await expect(page.getByRole('button', { name: 'ยกเลิกเอกสาร' })).toBeDisabled();
  await page.getByRole('tab', { name: 'ผลต่อบัญชี' }).click();
  await expect(page.getByRole('tabpanel').getByRole('button', { name: 'กลับรายการ' })).toHaveCount(0); // reversed once only
  await shot(page, 'jv-reversed');
  // the reversal is a JV of its own: lines mirrored, linked to the original
  const doc = await api<{ number: string }>(page, `/docs/JV/${id}`);
  const list = await api<{ items: { id: string; number: string; reference?: string; total: string }[] }>(page, '/docs/JV?limit=100');
  const rev = list.items.find((x) => x.reference === `กลับรายการ ${doc.number}`)!;
  expect(rev).toMatchObject({ total: '2500.00' });
  expect(lines(await api<Ledger>(page, `/docs/JV/${id}/ledger`))).toEqual([['5110', '2500.00', '0.00'], ['2120', '0.00', '2500.00']]);
  expect(lines(await api<Ledger>(page, `/docs/JV/${rev.id}/ledger`))).toEqual([['5110', '0.00', '2500.00'], ['2120', '2500.00', '0.00']]);
  // it shows in the general journal, with its source link
  await page.goto('/accounting/journals?source=JV');
  await expect(page.getByRole('link', { name: new RegExp(doc.number) })).toBeVisible();
  await expect(page.getByRole('link', { name: new RegExp(rev.number) })).toBeVisible();
});

test('the unbalanced draft: the difference is the server\'s, issue is blocked; control accounts are not offered and the API refuses them with the exit', async ({ page }) => {
  await page.goto('/'); const id = await fixtureId(page, 'jvDraftUnbalanced');
  await page.goto(`${BASE}/${id}/edit`);
  const balance = page.getByRole('region', { name: 'ยอดรวมใบสำคัญ' });
  await expect(balance.getByTestId('jv-diff')).toHaveText('100.00');
  await expect(balance).toContainText('ยอดเดบิตและเครดิตไม่เท่ากัน (ต่าง 100.00)');
  await expect(page.getByRole('region', { name: 'ยังขาดอะไร' })).toContainText('ยอดเดบิตและเครดิตไม่เท่ากัน (ต่าง 100.00)');
  await expect(page.getByRole('button', { name: 'บันทึกและออกใบสำคัญทั่วไป' })).toBeDisabled();
  await shot(page, 'jv-unbalanced');
  // the type-ahead only offers accounts a JV may post to
  const cell = page.getByRole('combobox', { name: 'บัญชีรายการ 1' });
  await cell.fill('1130');
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await expect(page.getByText('ไม่พบรายการที่ตรงกัน').first()).toBeVisible();
  // the server refuses them anyway (a caller that skips the screen)
  const mk = { header: { documentDate: '2026-10-10' }, lines: [{ id: 'x1', description: 'x', qty: '1', unit: '', unitPrice: '0.00', taxCode: 'EX', accountCode: '1130', debit: '100.00', credit: '0.00' }, { id: 'x2', description: 'x', qty: '1', unit: '', unitPrice: '0.00', taxCode: 'EX', accountCode: '2120', debit: '0.00', credit: '100.00' }] };
  const c = await post(page, '/docs/JV/compute', mk);
  expect(c.status).toBe(200);
  expect((c.json as unknown as { missing: { code?: string; message: string }[] }).missing.some((m) => m.code === 'ledger.control_account' && m.message.includes('ใบเสร็จรับเงิน'))).toBe(true);
});

test('กลับรายการ is refused for a document entry with the exit (cancel / correct the document); the document ledger offers no action', async ({ page }) => {
  await page.goto('/'); const ti = await fixtureId(page, 'tiIssuedUnpaid');
  const doc = await api<{ number: string }>(page, `/docs/TI/${ti}`);
  const r = await post(page, `/docs/TI/${ti}/reverse`, {});
  expect(r.status).toBe(422);
  expect(r.json.code).toBe('ledger.reverse_document');
  expect(r.json.title).toContain(`ยกเลิกหรือแก้ไขเอกสาร ${doc.number}`);
  await page.goto(`/sales/tax-invoices/${ti}`);
  await page.getByRole('tab', { name: 'ผลต่อบัญชี' }).click();
  await expect(page.getByRole('tabpanel').getByRole('heading', { name: /รายการบัญชีเดิม/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'กลับรายการ' })).toHaveCount(0);
});

test('the accrual: reverses itself on day 1 of the next month (a system JV), its ledger and chain say so; the system reversal and a reversed JV are final', async ({ page }) => {
  await page.goto('/'); const id = await fixtureId(page, 'jvAccrual');
  await page.goto(`${BASE}/${id}`);
  await page.getByRole('tab', { name: 'ผลต่อบัญชี' }).click();
  await expect(page.getByTestId('jv-auto-note')).toBeVisible();
  await expect(page.getByRole('tabpanel').getByRole('button', { name: 'กลับรายการ' })).toHaveCount(0); // its reversal exists already
  await page.getByRole('tab', { name: 'เอกสารที่เกี่ยวข้อง' }).click();
  const auto = page.getByRole('link', { name: /JV-202610-0001/ });
  await expect(auto).toBeVisible();
  await auto.click();
  await expect(page.getByTestId('doc-number')).toHaveText('JV-202610-0001');
  const lock = page.getByRole('status', { name: /ล็อก/ }).first();
  await expect(lock).toContainText('ใบกลับรายการอัตโนมัติ');
  await shot(page, 'jv-auto-reversal');
  // the reversed reclass jv-2 is final
  const jv2 = await fixtureId(page, 'jvIssued');
  await page.goto(`${BASE}/${jv2}`);
  await expect(page.getByRole('status', { name: /ล็อก/ }).first()).toContainText('สิ้นสุดแล้ว');
  await shot(page, 'jv-final-banner');
  // paper
  await page.getByRole('tab', { name: 'กระดาษ' }).click();
  await expect(page.locator('[data-paper-ready="true"]')).toBeVisible();
  await expect(page.getByText('ผู้จัดทำ').first()).toBeVisible();
  await axeClean(page);
});

test('the general journal lists every entry of the company with its source link, filters by source / account, and the debits equal the credits', async ({ page }) => {
  await page.goto('/accounting/journals');
  await expect(page.getByRole('heading', { level: 1, name: 'สมุดรายวัน' })).toBeVisible();
  await expect(page.getByRole('link', { name: /^TI-/ }).first()).toBeVisible();
  await expect(page.getByRole('link', { name: /STL-001/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /JV-202609-0001/ })).toBeVisible();
  await expect(page.getByText('ยอดกระทบตรงกัน').or(page.getByText(/เดบิตรวม .* เทียบกับเครดิตรวม/)).first()).toBeVisible();
  await shot(page, 'general-journal');
  await axeClean(page);
  await page.getByLabel('ที่มา').selectOption('JV');
  await expect(page).toHaveURL(/source=JV/);
  await expect(page.getByRole('link', { name: /^TI-/ })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /JV-202609-0001/ })).toBeVisible();
  await page.getByLabel('บัญชี (รหัส)').fill('2120');
  await expect(page).toHaveURL(/account=2120/);
  await expect(page.getByRole('cell', { name: /^2120 / }).first()).toBeVisible();
  await expect(page.getByRole('cell', { name: /^5110 / })).toHaveCount(0);
});

test('mobile (390 x 844): the JV editor is usable - one card per line, the balance under it, no horizontal scroll', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE}/new`);
  await expect(page.getByRole('combobox', { name: 'บัญชีรายการ 1' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'เดบิตรายการ 2' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await shot(page, 'jv-editor-mobile');
  await axeClean(page);
});

test('revise an accrual from its edit page: reverse + repost, and its pending auto-reversal follows to the new amount', async ({ page }) => {
  await page.goto('/'); const id = await fixtureId(page, 'jvAccrual');
  await page.goto(`${BASE}/${id}`);
  await page.getByRole('link', { name: 'แก้ไข' }).click();
  await page.locator('[data-cell="0:debit"]').fill('9000');
  await page.locator('[data-cell="1:credit"]').fill('9000');
  await expect(page.getByRole('region', { name: 'ยอดรวมใบสำคัญ' }).getByTestId('jv-diff')).toHaveText('0.00');
  await page.getByRole('button', { name: 'บันทึกการแก้ไข' }).click();
  await page.getByRole('alertdialog', { name: /แผนการแก้ไข/ }).getByRole('button', { name: 'ยืนยันทั้งหมด' }).click();
  await expect(page.getByText('฿9,000.00')).toBeVisible();
  const ledger = await api<Ledger>(page, `/docs/JV/${id}/ledger`);
  expect(ledger.entries.map((e) => e.kind)).toEqual(['original', 'reversal', 'correction']);
  expect(lines(ledger, 2)).toEqual([['5120', '9000.00', '0.00'], ['2120', '0.00', '9000.00']]);
  const auto = await api<{ totals: { total: string }; status: string }>(page, '/docs/JV/jv-1-auto');
  expect(auto).toMatchObject({ status: 'issued', totals: { total: '9000.00' } });
  expect(lines(await api<Ledger>(page, '/docs/JV/jv-1-auto/ledger'), 2)).toEqual([['5120', '0.00', '9000.00'], ['2120', '9000.00', '0.00']]);
});

test('a reversed JV cannot be revised: the edit page says so (final), nothing is posted', async ({ page }) => {
  await page.goto('/'); const id = await fixtureId(page, 'jvIssued');
  const before = await api<Ledger>(page, `/docs/JV/${id}/ledger`);
  await page.goto(`${BASE}/${id}`);
  await page.getByRole('link', { name: 'แก้ไข' }).click();
  await page.locator('[data-cell="0:debit"]').fill('4600');
  await page.locator('[data-cell="1:credit"]').fill('4600');
  await page.getByRole('button', { name: 'บันทึกการแก้ไข' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'ถูกกลับรายการโดย' })).toBeVisible();
  expect(await api<Ledger>(page, `/docs/JV/${id}/ledger`)).toEqual(before);
});
