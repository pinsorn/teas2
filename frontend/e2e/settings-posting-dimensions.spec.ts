import { expect, test, type Page } from '@playwright/test';
import { axeClean } from './helpers/axe';
import { fixtureId } from './helpers/fixtures';
import { screenContract } from './helpers/screen-contract';

const shot = async (page: Page, name: string) => { if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/${name}.png`, fullPage: true }); };
const ACC = 'role=accountant&company=vat&state=normal';
const ADMIN = 'role=admin&company=vat&state=normal';
const api = <T,>(page: Page, path: string) => page.evaluate(async (p) => (await fetch(`/bff/v1${p}`)).json(), path) as Promise<T>;
const noSideScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

// posting rules are the accountant's (ledger.posting.manage: the operator has no access); dimensions are settings (settings.manage: the accountant has none)
screenContract({ name: 'posting settings', path: '/settings/posting', heading: 'การลงบัญชี', company: 'both', states: ['loading', 'error', 'forbidden'], forbiddenRole: 'operator' });
screenContract({ name: 'dimensions settings', path: '/settings/dimensions', heading: 'มิติ', company: 'both', roles: ['admin'], states: ['loading', 'error', 'forbidden'], forbiddenRole: 'accountant' });

test.beforeEach(async ({ page }) => { await page.goto('/'); await page.evaluate(() => localStorage.clear()); await page.reload(); });

test('rules: an item-level Revenue rule for SV-02 -> 4200 wins in the test tab; a class mismatch is refused in the form; the default of a role cannot be deleted', async ({ page }) => {
  await page.goto(`/settings/posting?${ACC}`);
  await expect(page.getByRole('heading', { level: 1, name: 'การลงบัญชี' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'กฎการลงบัญชี' })).toHaveAttribute('aria-selected', 'true');
  await shot(page, 'posting-rules-desktop');
  const row = page.getByRole('row').filter({ hasText: 'ลูกหนี้การค้า' }).filter({ hasText: 'ค่าเริ่มต้นบริษัท' }).first();
  await expect(row.getByRole('button', { name: /^ลบกฎ/ })).toHaveCount(0); // every role keeps its company default
  await expect(row.getByText('ค่าเริ่มต้น', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'เพิ่มกฎ' }).click();
  const dialog = page.getByRole('dialog', { name: 'เพิ่มกฎการลงบัญชี' });
  await dialog.getByLabel('ระดับของกฎ').selectOption({ label: 'สินค้า/บริการ' });
  await dialog.getByLabel(/^กุญแจ/).fill('SV-02');
  await dialog.getByLabel('บทบาทบัญชี').selectOption('Revenue');
  await expect(dialog.getByText('บทบาทนี้ใช้ได้เฉพาะบัญชีหมวด: รายได้')).toBeVisible();
  await expect(dialog.getByLabel('บัญชี', { exact: true }).locator('option', { hasText: '1130' })).toHaveCount(0); // the receivable is not offered to a revenue role
  await dialog.getByLabel('บัญชี', { exact: true }).selectOption({ value: '4200' });
  await shot(page, 'posting-rule-form-desktop');
  await dialog.getByRole('button', { name: 'บันทึก' }).click();
  await expect(dialog).toHaveCount(0);
  const rules = await api<{ items: { id: string; accountCode: string }[] }>(page, '/settings/posting/rules');
  expect(rules.items.find((r) => r.id === 'item|SV-02|Revenue')?.accountCode).toBe('4200');

  await page.getByRole('tab', { name: 'ทดสอบการลงบัญชี' }).click();
  await page.getByLabel('ประเภทเอกสาร').selectOption('TI');
  await page.getByLabel('สินค้า/บริการ').selectOption({ value: 'SV-02' });
  await page.getByRole('button', { name: 'ทดสอบ' }).click();
  const revenue = page.locator('[data-role="Revenue"]');
  await expect(revenue).toContainText('สินค้า/บริการ SV-02'); // the winning level, not the default
  await expect(revenue).toContainText('4200');
  await expect(page.locator('[data-role="AR"]')).toContainText('ค่าเริ่มต้นบริษัท');
  await expect(page.getByTestId('preview-result').getByRole('table').nth(1)).toContainText('4200');
  await shot(page, 'posting-preview-desktop');
  await axeClean(page);

  await page.getByLabel('สินค้า/บริการ').selectOption({ value: '' }); // without the item the default wins again
  await page.getByRole('button', { name: 'ทดสอบ' }).click();
  await expect(page.locator('[data-role="Revenue"]')).toContainText('ค่าเริ่มต้นบริษัท');
  await expect(page.locator('[data-role="Revenue"]')).toContainText('4100');
});

test('rules: a mismatching account is refused by the server with the class named; the audit trail has the change', async ({ page }) => {
  await page.goto(`/settings/posting?${ACC}`);
  await page.getByRole('button', { name: 'เพิ่มกฎ' }).click();
  const dialog = page.getByRole('dialog', { name: 'เพิ่มกฎการลงบัญชี' });
  await dialog.getByLabel('ระดับของกฎ').selectOption({ label: 'ประเภทเอกสาร' });
  await dialog.getByLabel(/^กุญแจ/).selectOption('TI');
  await dialog.getByLabel('บทบาทบัญชี').selectOption('Revenue');
  await dialog.getByLabel('บัญชี', { exact: true }).selectOption({ value: '4210' });
  await dialog.getByRole('button', { name: 'บันทึก' }).click();
  await expect(dialog).toHaveCount(0);
  const res = await page.evaluate(async () => (await fetch('/bff/v1/settings/posting/rules', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ level: 'item', key: 'SV-01', role: 'Revenue', accountCode: '1130' }) })).json());
  expect(res).toMatchObject({ code: 'posting.class_mismatch' });
  const audit = await api<{ items: { command: string }[] }>(page, '/reports/audit-log?command=posting.rule.create');
  expect(JSON.stringify(audit)).toContain('posting.rule.create');
});

test('categories: the account takes expense accounts only; a new category is offered on a line; one in use cannot be deleted', async ({ page }) => {
  await page.goto(`/settings/posting?${ACC}`);
  await page.getByRole('tab', { name: 'หมวดค่าใช้จ่าย' }).click();
  await expect(page.getByRole('row').filter({ hasText: 'supplies' })).toBeVisible();
  await shot(page, 'posting-categories-desktop');
  await page.getByRole('button', { name: 'เพิ่มหมวด' }).click();
  const dialog = page.getByRole('dialog', { name: 'เพิ่มหมวดค่าใช้จ่าย' });
  await dialog.getByLabel('รหัสหมวด').fill('training');
  await dialog.getByLabel('ชื่อหมวด').fill('ค่าฝึกอบรม');
  await expect(dialog.getByLabel('บัญชีค่าใช้จ่าย').locator('option', { hasText: '4100' })).toHaveCount(0); // a revenue account is not an expense account
  await dialog.getByLabel('บัญชีค่าใช้จ่าย').selectOption({ value: '5140' });
  await dialog.getByRole('button', { name: 'บันทึก' }).click();
  await expect(page.getByRole('row').filter({ hasText: 'ค่าฝึกอบรม' })).toBeVisible();
  await page.getByRole('button', { name: 'ลบหมวด ค่าฝึกอบรม' }).click(); // unused: deleted
  await page.getByRole('alertdialog').getByRole('button', { name: 'ลบ' }).click();
  await expect(page.getByRole('row').filter({ hasText: 'ค่าฝึกอบรม' })).toHaveCount(0);
  await page.getByRole('row').filter({ hasText: 'ค่าวัสดุสิ้นเปลือง' }).getByRole('button', { name: /^ลบหมวด/ }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'ลบ' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'ปิดใช้งานแทน' })).toBeVisible(); // in use: deactivate instead
});

test('dimensions: types and values, a required account rule shows in the editor with its exit, and the header value clears it', async ({ page }) => {
  await page.goto(`/settings/dimensions?${ADMIN}`);
  await expect(page.getByRole('heading', { level: 1, name: 'มิติ' })).toBeVisible();
  await expect(page.getByRole('group', { name: 'แผนก' })).toContainText('การตลาด');
  await expect(page.getByRole('group', { name: 'โปรเจกต์' })).toContainText('เว็บไซต์ลูกค้า A');
  await shot(page, 'dimensions-desktop');
  await page.getByLabel('รหัสค่าของแผนก').fill('D-04');
  await page.getByLabel('ชื่อค่าของแผนก').fill('บัญชี');
  await page.getByRole('button', { name: 'เพิ่มค่าของแผนก' }).click();
  await expect(page.getByRole('group', { name: 'แผนก' })).toContainText('D-04');
  await page.getByRole('button', { name: 'ลบ แผนก D-04' }).click(); // unused: deleted
  await page.getByRole('alertdialog').getByRole('button', { name: 'ลบ' }).click();
  await expect(page.getByRole('group', { name: 'แผนก' })).not.toContainText('D-04');


  await page.getByLabel(/^4100 .* มิติแผนก$/).selectOption({ label: 'ต้องระบุ' });
  await expect.poll(async () => (await api<{ items: { code: string; rules: Record<string, string> }[] }>(page, '/settings/dimensions/account-rules')).items.find((a) => a.code === '4100')?.rules).toEqual({ department: 'required' });

  const draft = await fixtureId(page, 'tiDraft');
  await page.goto(`/sales/tax-invoices/${draft}/edit?${ACC}`);
  const missing = page.getByRole('region', { name: 'ยังขาดอะไร' });
  await expect(missing).toContainText('บัญชี 4100 ต้องระบุแผนก');
  await expect(missing).toContainText('ระบุมิติที่หัวเอกสาร');
  await page.getByRole('button', { name: 'ระบุมิติ', exact: true }).click();
  await page.getByLabel('แผนก', { exact: true }).selectOption({ value: 'D-01' });
  await expect(missing).toHaveText(/ครบแล้ว/);
  await shot(page, 'editor-header-dimension-desktop');
  await axeClean(page);
});

test('dimensions: a value in use cannot be deleted - the exit is to deactivate it, and an old document keeps showing it', async ({ page }) => {
  await page.goto(`/settings/dimensions?role=admin&company=nonvat&state=normal`);
  await page.getByRole('button', { name: 'ลบ โปรเจกต์ P-A' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'ลบ' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'ปิดใช้งานแทน' })).toBeVisible();
  await page.getByRole('button', { name: 'ปิดใช้งาน โปรเจกต์ P-A' }).click();
  await expect(page.getByRole('button', { name: 'เปิดใช้งาน โปรเจกต์ P-A' })).toBeVisible(); // the row now offers the way back
  const view = await api<{ types: { key: string; values: { code: string; active: boolean; inUse: boolean }[] }[] }>(page, '/settings/dimensions');
  expect(view.types.find((t) => t.key === 'project')!.values.find((v) => v.code === 'P-A')).toMatchObject({ active: false, inUse: true });
});

test.describe('mobile 390x844', () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test('posting tabs and the dimensions page fit the phone', async ({ page }) => {
    await page.goto(`/settings/posting?${ACC}`);
    await expect(page.getByRole('heading', { level: 1, name: 'การลงบัญชี' })).toBeVisible();
    expect(await noSideScroll(page)).toBe(true);
    await shot(page, 'posting-rules-mobile');
    await page.getByRole('tab', { name: 'หมวดค่าใช้จ่าย' }).click();
    await expect(page.getByRole('row').filter({ hasText: 'supplies' })).toBeVisible();
    expect(await noSideScroll(page)).toBe(true);
    await shot(page, 'posting-categories-mobile');
    await page.getByRole('tab', { name: 'ทดสอบการลงบัญชี' }).click();
    await page.getByRole('button', { name: 'ทดสอบ' }).click();
    await expect(page.getByTestId('preview-result')).toBeVisible();
    expect(await noSideScroll(page)).toBe(true);
    await shot(page, 'posting-preview-mobile');
    await page.goto(`/settings/dimensions?${ADMIN}`);
    await expect(page.getByRole('heading', { level: 1, name: 'มิติ' })).toBeVisible();
    expect(await noSideScroll(page)).toBe(true);
    await shot(page, 'dimensions-mobile');
  });
});
