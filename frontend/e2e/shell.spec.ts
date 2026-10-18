import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

test.beforeEach(async ({ page }) => { await page.goto('/'); await page.evaluate(() => localStorage.clear()); await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'งานของฉัน' })).toBeVisible(); // app hydrated, mock worker ready
});

const serious = async (page: Page) => {
  const r = await new AxeBuilder({ page }).analyze();
  return r.violations.filter((v) => ['serious', 'critical'].includes(v.impact ?? ''))
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`);
};
const setState = async (page: Page, label: string) => {
  await page.getByRole('button', { name: 'โหมดตัวอย่าง' }).click();
  await page.getByLabel('สถานะหน้าจอ').selectOption({ label });
};

test('accountant on the VAT company sees ขาย > ใบกำกับภาษี', async ({ page }) => {
  await expect(page.getByRole('navigation').getByRole('link', { name: 'ใบกำกับภาษี' })).toBeVisible();
});

test('switching to the non-VAT company hides ใบกำกับภาษี without a stale flash', async ({ page }) => {
  await page.getByRole('button', { name: 'โหมดตัวอย่าง' }).click();
  await page.getByLabel('บริษัท').selectOption('nonvat');
  await expect(page.getByRole('navigation').getByRole('link', { name: 'ใบกำกับภาษี' })).toHaveCount(0);
  await expect(page.getByRole('navigation').getByRole('link', { name: 'ใบแจ้งหนี้' })).toBeVisible();
});

test('the company switcher in the sidebar switches company', async ({ page }) => {
  await page.getByRole('button', { name: /กิจการที่ใช้งาน/ }).click();
  await page.getByRole('menuitem', { name: /บ้านต้นข้าว/ }).click();
  await expect(page.getByRole('navigation').getByRole('link', { name: 'ใบแจ้งหนี้' })).toBeVisible();
  await expect(page.getByRole('navigation').getByRole('link', { name: 'ใบกำกับภาษี' })).toHaveCount(0);
});

test('Home data re-keys after a company switch (non-VAT shows its own data, not the VAT company data)', async ({ page }) => {
  const main = page.getByRole('main');
  await expect(main.getByText('ภ.พ.30')).toBeVisible();
  await expect(main.getByText('ภาษีขายเดือนนี้')).toBeVisible();
  await page.getByRole('button', { name: 'โหมดตัวอย่าง' }).click();
  await page.getByLabel('บริษัท').selectOption('nonvat');
  await expect(main.getByText('ภ.พ.30')).toHaveCount(0);
  await expect(main.getByText('ภาษีขายเดือนนี้')).toHaveCount(0);
  await expect(main.getByText('ภ.ง.ด.53')).toBeVisible();
});

test('Ctrl+K opens the command menu', async ({ page }) => {
  await page.keyboard.press('Control+k');
  await expect(page.getByRole('dialog')).toBeVisible();
});

test('command menu goes to a page on Enter', async ({ page }) => {
  await page.keyboard.press('Control+k');
  await page.getByRole('combobox').fill('งบการเงิน'); // a page with no "create" action of its own (a built document type also lists "สร้าง…")
  await expect(page.getByRole('option', { name: 'งบการเงิน' })).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/reports\/financial-statements$/);
  await expect(page).toHaveTitle('งบการเงิน · TEAS 2');
});

test('home has no serious accessibility violations', async ({ page }) => {
  await expect(page.getByRole('heading', { level: 1, name: 'งานของฉัน' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'รออนุมัติ' })).toBeVisible();
  expect(await serious(page)).toEqual([]);
});

test('home title and a not-built route', async ({ page }) => {
  await expect(page).toHaveTitle('งานของฉัน · TEAS 2');
  await page.getByRole('button', { name: 'โหมดตัวอย่าง' }).click(); // every non-settings route is built; settings needs settings.manage (admin)
  await page.getByLabel('บทบาท').selectOption('admin');
  await page.goto('/settings/posting'); // ST1 built the company, users and roles pages; posting is ST2
  await expect(page.getByText('ส่วนนี้ยังไม่เปิดใช้งาน')).toBeVisible();
  expect(await serious(page)).toEqual([]);
  await page.goto('/nope/nothing');
  await expect(page.getByRole('heading', { name: 'ไม่พบหน้าที่ต้องการ' })).toBeVisible();
});

test('an error on Home is shown as an error, not as no data', async ({ page }) => {
  await setState(page, 'เกิดข้อผิดพลาด');
  await expect(page.getByText('โหลดข้อมูลไม่สำเร็จ').first()).toBeVisible();
  await expect(page.getByText('ไม่มีเอกสารรออนุมัติ')).toHaveCount(0);
  expect(await serious(page)).toEqual([]);
});

test('a forbidden Home is distinct from an empty one', async ({ page }) => {
  await setState(page, 'ไม่มีสิทธิ์');
  await expect(page.getByText('คุณไม่มีสิทธิ์ดูส่วนนี้').first()).toBeVisible();
  await expect(page.getByText('ไม่มีเอกสารรออนุมัติ')).toHaveCount(0);
});

test('an empty Home says so per section', async ({ page }) => {
  await setState(page, 'ไม่มีข้อมูล');
  await expect(page.getByText('ไม่มีเอกสารรออนุมัติ')).toBeVisible();
  await expect(page.getByText('โหลดข้อมูลไม่สำเร็จ')).toHaveCount(0);
});

test.describe('mobile', () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test('menu opens from the topbar and has no serious violations', async ({ page }) => {
    await expect(page.getByRole('navigation', { name: 'เมนูหลัก' })).toHaveCount(0);
    await page.getByRole('button', { name: 'เปิดเมนู' }).click();
    await expect(page.getByRole('navigation', { name: 'เมนูหลัก' }).getByRole('link', { name: 'ใบกำกับภาษี' })).toBeVisible();
    expect(await serious(page)).toEqual([]);
  });
});
