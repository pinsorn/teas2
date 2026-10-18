import { expect, test, type Page } from '@playwright/test';
import th from '../src/messages/th.json';
import { axeClean } from './helpers/axe';
import { fixtureId } from './helpers/fixtures';
import { screenContract } from './helpers/screen-contract';

const shot = async (page: Page, name: string) => { if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/${name}.png`, fullPage: true }); };
const ADMIN = 'role=admin&company=vat&state=normal';
const api = <T,>(page: Page, path: string) => page.evaluate(async (p) => (await fetch(`/bff/v1${p}`)).json(), path) as Promise<T>;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

// settings are the administrator's: company needs settings.manage, users and roles need users.manage (the accountant has neither; the operator neither)
screenContract({ name: 'company settings', path: '/settings/company', heading: 'ข้อมูลบริษัท', company: 'both', roles: ['admin'], states: ['loading', 'error', 'forbidden'], forbiddenRole: 'accountant' });
screenContract({ name: 'users', path: '/settings/users', heading: 'ผู้ใช้และสิทธิ์', company: 'both', roles: ['admin'], states: ['empty', 'loading', 'error', 'forbidden'], forbiddenRole: 'accountant' });
screenContract({ name: 'roles', path: '/settings/roles', heading: 'บทบาทและสิทธิ์', company: 'both', roles: ['admin'], states: ['empty', 'loading', 'error', 'forbidden'], forbiddenRole: 'operator' });

test.beforeEach(async ({ page }) => { await page.goto('/'); await page.evaluate(() => localStorage.clear()); await page.reload(); });

test('company: fiscal year is locked while periods are closed; legal identity is edited behind the confirm dialog; each section saves on its own', async ({ page }) => {
  await page.goto('/');
  const ti = await fixtureId(page, 'tiIssuedUnpaid'); // resolved before the edit
  await page.goto(`/settings/company?${ADMIN}`);
  await expect(page.getByRole('heading', { level: 1, name: 'ข้อมูลบริษัท' })).toBeVisible();
  const locked = page.getByTestId('fiscal-locked');
  await expect(locked).toContainText('ติดต่อผู้ดูแลระบบเพื่อเปิดงวดก่อน');
  await expect(page.getByLabel('เดือนเริ่มต้นปีบัญชี')).toHaveCount(0);
  await expect(page.getByTestId('vat-status')).toHaveText('จดทะเบียนภาษีมูลค่าเพิ่ม');
  await shot(page, 'company-desktop');

  const identity = page.getByRole('region', { name: 'ข้อมูลตามทะเบียน' });
  await expect(identity.getByLabel('ชื่อนิติบุคคล (ไทย)')).toHaveCount(0); // read-only until the confirmation
  await identity.getByRole('button', { name: 'แก้ไขข้อมูลตามทะเบียน' }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText('เอกสารที่ออกแล้วและแบบที่ยื่นแล้วจะยังแสดงชื่อ');
  await dialog.getByRole('button', { name: 'ยืนยันและบันทึก' }).click();
  await identity.getByLabel('ชื่อนิติบุคคล (ไทย)').fill('บริษัท มะลิวัลย์ ใหม่ จำกัด');
  await identity.getByLabel('เลขประจำตัวผู้เสียภาษี').fill('0105569012346');
  await identity.getByRole('button', { name: 'บันทึก' }).click();
  await expect(identity.getByText('เลขประจำตัวผู้เสียภาษีไม่ถูกต้อง')).toBeVisible();
  await identity.getByLabel('เลขประจำตัวผู้เสียภาษี').fill('0105569012345');
  await identity.getByRole('button', { name: 'บันทึก' }).click();
  await expect(identity.getByRole('status')).toHaveText('บันทึกแล้ว');
  await expect(identity.getByText('บริษัท มะลิวัลย์ ใหม่ จำกัด')).toBeVisible();
  await page.goto(`/print/TI/${ti}?role=accountant&company=vat`); // I3: the issued tax invoice still prints the name it was issued under
  await expect(page.getByText('บริษัท มะลิวัลย์ ดีไซน์ เวิร์คส์ จำกัด').first()).toBeAttached();
  await expect(page.getByText('บริษัท มะลิวัลย์ ใหม่ จำกัด')).toHaveCount(0);
  await page.goto(`/settings/company?${ADMIN}`);
  const identity2 = page.getByRole('region', { name: 'ข้อมูลตามทะเบียน' });
  await expect(identity2.getByText('บริษัท มะลิวัลย์ ใหม่ จำกัด')).toBeVisible();

  const payroll = page.getByRole('region', { name: 'เงินเดือนและประกันสังคม' });
  await payroll.getByLabel('เลขที่บัญชีนายจ้าง (ประกันสังคม)').fill('123');
  await payroll.getByRole('button', { name: 'บันทึก' }).click();
  await expect(payroll.getByText('ต้องเป็นตัวเลข 10 หลัก')).toBeVisible();
  await payroll.getByLabel('เลขที่บัญชีนายจ้าง (ประกันสังคม)').fill('0987654321');
  await payroll.getByRole('button', { name: 'บันทึก' }).click();
  await expect(payroll.getByRole('status')).toHaveText('บันทึกแล้ว');

  const notes = page.getByRole('region', { name: 'หมายเหตุเริ่มต้นตามประเภทเอกสาร' });
  await notes.getByLabel('ใบเสนอราคา', { exact: true }).fill('หมายเหตุใหม่ทดสอบ');
  await notes.getByRole('button', { name: 'บันทึก' }).click();
  await expect(notes.getByRole('status')).toHaveText('บันทึกแล้ว');

  const images = page.getByRole('region', { name: 'รูปภาพ' });
  await images.getByLabel('โลโก้').setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: PNG });
  await expect(images.getByRole('img', { name: 'โลโก้' })).toBeVisible();
  await images.getByRole('button', { name: 'บันทึก' }).click();
  await expect(images.getByRole('status')).toHaveText('บันทึกแล้ว');

  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'ข้อมูลบริษัท' })).toBeVisible(); // the mock worker is up once the page renders
  const co = await api<{ legalNameTh: string; ssoEmployerAccountNo: string; logoDataUrl: string; fiscalYearStartMonth: number }>(page, '/settings/companies/co-vat');
  expect(co).toMatchObject({ legalNameTh: 'บริษัท มะลิวัลย์ ใหม่ จำกัด', ssoEmployerAccountNo: '0987654321', fiscalYearStartMonth: 1 });
  expect(co.logoDataUrl).toMatch(/^data:image\/png;base64,/);
  expect((await api<Record<string, string>>(page, '/settings/default-notes')).QT).toBe('หมายเหตุใหม่ทดสอบ');
  const audit = await page.evaluate(() => (JSON.parse(localStorage.getItem('teas2.mock.state.v26') ?? '{}') as { audit: { command: string }[] }).audit); // the trail the audit screen reads
  expect(audit.map((a) => a.command)).toEqual(expect.arrayContaining(['company.update.identity', 'company.update.payroll', 'company.update.notes', 'company.update.images']));
  await axeClean(page);
});

test('users: an invite link is shown once and never again; the last administrator cannot be deactivated', async ({ page }) => {
  await page.goto(`/settings/users?${ADMIN}`);
  await expect(page.getByRole('heading', { level: 1, name: 'ผู้ใช้และสิทธิ์' })).toBeVisible();
  await expect(page.getByRole('row', { name: /วิชัย/ })).toBeVisible();
  await shot(page, 'users-desktop');

  await page.getByRole('button', { name: 'เชิญผู้ใช้' }).first().click();
  const form = page.getByRole('dialog');
  await form.getByLabel('ชื่อ', { exact: true }).fill('ใหม่ ทดสอบ');
  await form.getByLabel('อีเมล').fill('new@maliwan.example');
  await form.getByLabel('บทบาท').selectOption({ label: 'นักบัญชี' });
  await form.getByRole('button', { name: 'เชิญผู้ใช้' }).click();
  const linkDialog = page.getByRole('dialog', { name: /ลิงก์สำหรับ/ });
  await expect(linkDialog.getByText('ลิงก์เชิญ (ใช้ได้ 7 วัน)')).toBeVisible();
  const link = await linkDialog.getByRole('textbox').inputValue();
  expect(link).toMatch(/\/invite\/[\w-]{16,}$/);
  await shot(page, 'users-link');
  await linkDialog.getByRole('button', { name: 'เสร็จสิ้น' }).click();
  await expect(page.getByRole('row', { name: /ใหม่ ทดสอบ.*รอรับคำเชิญ/ })).toBeVisible();
  await page.getByRole('button', { name: 'ยืนยันคำเชิญของ ใหม่ ทดสอบ' }).click(); // the mock's "invite accepted"
  await expect(page.getByRole('row', { name: /ใหม่ ทดสอบ/ })).not.toContainText('รอรับคำเชิญ');
  await page.reload();
  const token = link.split('/').pop()!;
  expect(await page.content()).not.toContain(token);
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(token);

  // two administrators (the signed-in one and วิชัย): deactivating วิชัย is fine, then the signed-in one is the last
  await page.getByRole('button', { name: 'ปิดใช้งาน วิชัย ผู้ดูแลระบบ' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'ปิดใช้งาน' }).click();
  await expect(page.getByRole('button', { name: 'เปิดใช้งาน วิชัย ผู้ดูแลระบบ' })).toBeVisible();
  await page.getByRole('button', { name: 'ปิดใช้งาน สมศรี บัญชีดี' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'ปิดใช้งาน' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'ผู้ดูแลระบบคนสุดท้าย' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'ปิดใช้งาน สมศรี บัญชีดี' })).toBeVisible(); // still active
  await expect(page.getByRole('button', { name: 'เปิดใช้งาน สมศรี บัญชีดี' })).toHaveCount(0);
  await shot(page, 'users-last-admin');
});

test('roles: copy a system role, see the separation-of-duties warning, assign it; a role in use cannot be deleted', async ({ page }) => {
  await page.goto(`/settings/roles?${ADMIN}`);
  await expect(page.getByRole('heading', { level: 1, name: 'บทบาทและสิทธิ์' })).toBeVisible();
  await shot(page, 'roles-desktop');
  await page.getByRole('button', { name: 'ดูสิทธิ์ นักบัญชี' }).click();
  const view = page.getByRole('dialog');
  expect(await view.locator('input[data-code]').count()).toBe(Object.keys(th.permissions).length); // every catalogue code once
  expect(await view.locator('input[data-code]:enabled').count()).toBe(0); // a system role is read-only
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'คัดลอกเป็นบทบาทใหม่ นักบัญชี' }).click();
  const editor = page.getByRole('dialog');
  await expect(editor.getByLabel('ชื่อบทบาท')).toHaveValue('สำเนาของ นักบัญชี');
  await expect(editor.getByTestId('sod-warning')).toContainText('EX');
  await editor.getByLabel('ชื่อบทบาท').fill('นักบัญชีย่อย');
  await editor.getByRole('button', { name: 'บันทึกบทบาท' }).click();
  await expect(page.getByRole('row', { name: /นักบัญชีย่อย/ })).toContainText('บทบาทที่สร้างเอง');

  await page.goto(`/settings/users?${ADMIN}`);
  await page.getByRole('button', { name: 'แก้ไข นภา ใจดี' }).click();
  await page.getByRole('dialog').getByLabel('บทบาท').selectOption({ label: 'นักบัญชีย่อย' });
  await page.getByRole('dialog').getByRole('button', { name: 'บันทึก' }).click();
  await expect(page.getByRole('row', { name: /นภา.*นักบัญชีย่อย/ })).toBeVisible();

  await page.goto(`/settings/roles?${ADMIN}`);
  await page.getByRole('button', { name: 'ลบ นักบัญชีย่อย' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'ลบบทบาท' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'เพราะมีผู้ใช้ใช้อยู่' })).toBeVisible();
  await expect(page.getByRole('row', { name: /นักบัญชีย่อย/ })).toBeVisible();
});

test.describe('mobile', () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test('the three pages fit a phone without a horizontal page scroll', async ({ page }) => {
    for (const [path, h1] of [['company', 'ข้อมูลบริษัท'], ['users', 'ผู้ใช้และสิทธิ์'], ['roles', 'บทบาทและสิทธิ์']]) {
      await page.goto(`/settings/${path}?${ADMIN}`);
      await expect(page.getByRole('heading', { level: 1, name: h1 })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await shot(page, `${path}-mobile`);
    }
  });
});
