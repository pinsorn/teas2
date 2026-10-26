import { expect, test, type Page } from '@playwright/test';
import { axeClean } from './helpers/axe';
import { fixtureId } from './helpers/fixtures';

// SP1c HC3: login / TOTP / onboarding / session expiry / profile / public document link. Auth is mock-only (D-32).
const shot = async (page: Page, name: string) => { if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/${name}.png`, fullPage: true }); };
const ACC = 'role=accountant&company=vat&state=normal';
const FIXTURE_TI_TOKEN = 'c41f9a7be2d05863fa1c7e9b3d28a5f60b94e1d7', FIXTURE_QT_TOKEN = '7be3a05d9c1f4286e0b7d35a1f89c264d0e5a3b8';
const call = (page: Page, method: string, path: string, body?: unknown) =>
  page.evaluate(async ([m, p, b]) => { const r = await fetch(`/bff/v1${p}`, { method: m as string, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, json: await r.json().catch(() => undefined) }; }, [method, path, body] as const) as Promise<{ status: number; json: Record<string, unknown> & { items?: Record<string, unknown>[] } }>;
type Demo = { email: string; password: string; totpEmail: string; totpPassword: string; totpCode: string; recoveryCode: string };
const demo = async (page: Page): Promise<Demo> => (await call(page, 'GET', '/auth/demo')).json as unknown as Demo;
const MSG_BAD = 'อีเมลหรือรหัสผ่านไม่ถูกต้อง';

test.beforeEach(async ({ page }) => { await page.goto('/'); await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); }); await page.reload(); });

async function signIn(page: Page, email: string, password: string) {
  await page.getByLabel('อีเมล').fill(email);
  await page.getByLabel('รหัสผ่าน').fill(password);
  await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click();
}

test.describe('login and TOTP', () => {
  test('a wrong password and an unknown email give the same message; the fifth failure locks; axe', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByRole('heading', { level: 1, name: 'เข้าสู่ระบบ TEAS' })).toBeVisible();
    await axeClean(page);
    await shot(page, 'hc3-login-desktop');
    const d = await demo(page);
    await signIn(page, d.email, 'wrong-Password1');
    const wrongPw = (await page.getByTestId('login-error').textContent())!;
    await signIn(page, 'nobody@example.com', 'wrong-Password1');
    await expect(page.getByTestId('login-error')).toHaveText(MSG_BAD);
    expect(wrongPw).toBe(MSG_BAD); // never which of the two was wrong
    for (let i = 0; i < 3; i++) await signIn(page, d.email, `wrong-${i}`);
    await expect(page.getByTestId('login-error')).toHaveText(MSG_BAD); // 4th... still the same message
    await signIn(page, d.email, 'wrong-last');
    await signIn(page, d.email, d.password); // the right password while locked is refused as well
    await expect(page.getByTestId('login-error')).toContainText('ถูกล็อกชั่วคราว');
    await expect(page).toHaveURL(/\/login$/);
    await axeClean(page);
  });

  test('sign-in without TOTP lands on Home', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible(); // the page mounts once the mock worker is up
    const d = await demo(page);
    await signIn(page, d.email, d.password);
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
  });

  test('TOTP step: wrong code message, right code signs in, a recovery code works once; the challenge is never in the URL', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    const d = await demo(page);
    await signIn(page, d.totpEmail, d.totpPassword);
    await expect(page).toHaveURL(/\/login\/totp$/);
    expect(page.url()).not.toMatch(/challenge|[0-9a-f]{32}/);
    await expect(page.getByRole('heading', { level: 1, name: 'ยืนยันตัวตนสองขั้น' })).toBeVisible();
    await axeClean(page);
    await shot(page, 'hc3-totp-desktop');
    await page.getByLabel('รหัส 6 หลัก').fill('000000');
    await page.getByRole('button', { name: 'ยืนยัน' }).click();
    await expect(page.getByTestId('totp-error')).toHaveText('รหัสยืนยันไม่ถูกต้อง');
    await page.getByRole('button', { name: 'ใช้รหัสกู้คืนแทน' }).click();
    await page.getByLabel('รหัสกู้คืน').fill(d.recoveryCode);
    await page.getByRole('button', { name: 'ยืนยัน' }).click();
    await expect(page).toHaveURL(/\/$/);
    // the same recovery code again, after a fresh sign-in, is refused
    await page.goto('/login');
    await signIn(page, d.totpEmail, d.totpPassword);
    await page.getByRole('button', { name: 'ใช้รหัสกู้คืนแทน' }).click();
    await page.getByLabel('รหัสกู้คืน').fill(d.recoveryCode);
    await page.getByRole('button', { name: 'ยืนยัน' }).click();
    await expect(page.getByTestId('totp-error')).toHaveText('รหัสยืนยันไม่ถูกต้อง');
    await page.getByRole('button', { name: 'ใช้รหัสจากแอปแทน' }).click();
    await page.getByLabel('รหัส 6 หลัก').fill(d.totpCode);
    await page.getByRole('button', { name: 'ยืนยัน' }).click();
    await expect(page).toHaveURL(/\/$/);
  });
});

test.describe('onboarding', () => {
  test('six steps (axe on each), validation, then the company exists, is active and the opening-balance wizard opens with the cut-off; reset removes it', async ({ page }) => {
    await page.goto('/onboarding');
    await expect(page.getByRole('heading', { level: 1, name: 'เริ่มใช้งาน TEAS' })).toBeVisible();
    await axeClean(page);
    await shot(page, 'hc3-onboarding-1-desktop');
    await page.getByRole('button', { name: 'ถัดไป' }).click(); // empty: field errors
    await expect(page.getByText('ต้องระบุชื่อนิติบุคคล')).toBeVisible();
    await page.getByLabel('ชื่อนิติบุคคล (ไทย)').fill('บริษัท ตัวอย่างใหม่ จำกัด');
    await page.getByLabel('เลขประจำตัวผู้เสียภาษี 13 หลัก').fill('0105569056780'); // wrong check digit
    await page.getByLabel('ที่อยู่ตามทะเบียน').fill('1 ถนนทดสอบ กรุงเทพมหานคร 10110');
    await page.getByRole('button', { name: 'ถัดไป' }).click();
    await expect(page.getByText('เลขประจำตัวผู้เสียภาษีไม่ถูกต้อง')).toBeVisible();
    await axeClean(page); // with the errors showing
    await page.getByLabel('เลขประจำตัวผู้เสียภาษี 13 หลัก').fill('0105569056784');
    await page.getByRole('button', { name: 'ถัดไป' }).click();
    // 2: VAT
    await expect(page.getByRole('group', { name: /สถานะ VAT/ })).toBeVisible();
    await page.getByRole('button', { name: 'ถัดไป' }).click();
    await expect(page.getByText('ต้องเลือกสถานะ VAT')).toBeVisible();
    await page.getByRole('radio', { name: /ไม่ได้จดทะเบียน VAT/ }).check();
    await axeClean(page);
    await shot(page, 'hc3-onboarding-2-desktop');
    await page.getByRole('button', { name: 'ถัดไป' }).click();
    // 3: fiscal year start: only January is accepted; the server says so on the last step and sends you back here
    await page.getByLabel('เดือนเริ่มต้นปีบัญชี').selectOption('4');
    await axeClean(page);
    await shot(page, 'hc3-onboarding-3-desktop');
    await page.getByRole('button', { name: 'ถัดไป' }).click();
    // 4: chart template
    await expect(page.getByRole('radio', { name: /ผังบัญชีมาตรฐาน SME ไทย/ })).toBeChecked();
    await axeClean(page);
    await shot(page, 'hc3-onboarding-4-desktop');
    await page.getByRole('button', { name: 'ถัดไป' }).click();
    // 5: bank
    await page.getByRole('button', { name: 'ถัดไป' }).click();
    await expect(page.getByText('ต้องระบุชื่อบัญชี')).toBeVisible();
    await page.getByLabel('ชื่อบัญชี').fill('กสิกรไทย กระแสรายวัน');
    await page.getByLabel('เลขที่บัญชี').fill('999-9-99999-9');
    await axeClean(page);
    await shot(page, 'hc3-onboarding-5-desktop');
    await page.getByRole('button', { name: 'ถัดไป' }).click();
    // 6: cut-off
    await expect(page.getByLabel('วันตัดยอดยกมา')).toHaveValue('2026-09-30');
    await axeClean(page);
    await shot(page, 'hc3-onboarding-6-desktop');
    await page.getByRole('button', { name: 'สร้างบริษัทและไปกรอกยอดยกมา' }).click();
    await expect(page.getByText('ระบบรองรับเฉพาะปีบัญชีตามปีปฏิทิน')).toBeVisible(); // back on step 3 with the server's reason
    await page.getByLabel('เดือนเริ่มต้นปีบัญชี').selectOption('1');
    for (let i = 0; i < 3; i++) await page.getByRole('button', { name: 'ถัดไป' }).click(); // fiscal -> chart -> bank -> cut-off (the answers were kept)
    await page.getByRole('button', { name: 'สร้างบริษัทและไปกรอกยอดยกมา' }).click();

    // lands on the opening-balance wizard of the NEW company, with the cut-off it asked for
    await expect(page).toHaveURL(/\/accounting\/opening-balances\/new\?cutoff=2026-09-30$/);
    await expect(page.locator('#ob-cutoff')).toHaveValue('2026-09-30');
    const me = await call(page, 'GET', '/me');
    expect(me.json.activeCompanyId).toBe('co-new');
    expect((me.json.memberships as { companyId: string }[]).map((m) => m.companyId)).toContain('co-new'); // (the engine test holds that the user is its administrator; the shell shows the toolbar role)
    await shot(page, 'hc3-onboarding-landing-desktop');

    // "รีเซ็ตข้อมูลตัวอย่าง" removes it
    await page.getByRole('button', { name: 'โหมดตัวอย่าง' }).click();
    await page.getByRole('button', { name: 'รีเซ็ตข้อมูลตัวอย่าง' }).click();
    await expect.poll(async () => ((await call(page, 'GET', '/me')).json.memberships as { companyId: string }[]).map((m) => m.companyId)).toEqual(['co-vat', 'co-nonvat']);
    expect((await call(page, 'GET', '/me')).json.activeCompanyId).toBe('co-vat');
  });

  test('a second run is refused until the sample data is reset', async ({ page }) => {
    await page.goto('/onboarding');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    const body = { legalNameTh: 'บริษัท ตัวอย่างใหม่ จำกัด', taxId: '0105569056784', branchCode: '00000', address: '1 ถนนทดสอบ', vatRegistered: true, fiscalYearStartMonth: 1, template: 'sme-th', bank: { kind: 'cash', accountName: 'เงินสดย่อย' }, cutoff: '2026-09-30' };
    expect((await call(page, 'POST', '/onboarding', body)).status).toBe(201);
    expect((await call(page, 'POST', '/onboarding', body)).json).toMatchObject({ code: 'company.exists' });
  });
});

test.describe('session expiry', () => {
  // the dialogs are modal: the toolbar stays open (it is behind the overlay until the dialog is answered)
  const setSession = async (page: Page, state: string) => { const open = page.getByRole('button', { name: 'โหมดตัวอย่าง' }); if (await open.isVisible()) await open.click(); await page.getByLabel('เซสชัน').selectOption(state); };

  test('expiring: stay signed in, or sign out to the login page; axe', async ({ page }) => {
    await page.goto(`/?${ACC}`);
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    await setSession(page, 'expiring');
    const dlg = page.getByRole('dialog', { name: 'เซสชันกำลังจะหมดอายุ' });
    await expect(dlg).toBeVisible();
    await axeClean(page);
    await shot(page, 'hc3-expiring-desktop');
    await dlg.getByRole('button', { name: 'อยู่ในระบบต่อ' }).click();
    await expect(dlg).toBeHidden();
    await setSession(page, 'expiring');
    await page.getByRole('dialog', { name: 'เซสชันกำลังจะหมดอายุ' }).getByRole('button', { name: 'ออกจากระบบ' }).click();
    await expect(page).toHaveURL(/\/login$/);
  });

  test('signed out: an app page goes to the login page; signing in again comes back', async ({ page }) => {
    await page.goto(`/?${ACC}`);
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    await setSession(page, 'out');
    await expect(page).toHaveURL(/\/login$/);
    const d = await demo(page);
    await signIn(page, d.email, d.password);
    await expect(page).toHaveURL(/\/$/);
  });

  test('expired: a re-login dialog over the page; the typed draft is still there and saves after signing in again (no data loss)', async ({ page }) => {
    await page.goto(`/sales/quotations/new?${ACC}`);
    const ref = page.getByLabel('อ้างอิง');
    await ref.fill('ร่างก่อนหมดอายุ');
    await expect(page.getByText('บันทึกร่างแล้ว')).toBeVisible(); // autosaved once
    await ref.fill('ร่างก่อนหมดอายุ + แก้ไขหลังหมดอายุ');
    await setSession(page, 'expired');
    const dlg = page.getByRole('dialog', { name: 'เซสชันหมดอายุ' });
    await expect(dlg).toBeVisible();
    await axeClean(page);
    await shot(page, 'hc3-expired-desktop');
    await expect(ref).toHaveValue('ร่างก่อนหมดอายุ + แก้ไขหลังหมดอายุ'); // nothing was unmounted or reloaded
    await dlg.getByLabel('รหัสผ่าน').fill('not-the-password');
    await dlg.getByRole('button', { name: 'เข้าสู่ระบบอีกครั้ง' }).click();
    await expect(dlg.getByRole('alert')).toHaveText(MSG_BAD);
    // the demo route is open while expired
    const demoNow = await demo(page);
    await dlg.getByLabel('รหัสผ่าน').fill(demoNow.password);
    await dlg.getByRole('button', { name: 'เข้าสู่ระบบอีกครั้ง' }).click();
    await expect(dlg).toBeHidden();
    await expect(page).toHaveURL(/\/sales\/quotations\/new/); // the same page
    await expect(ref).toHaveValue('ร่างก่อนหมดอายุ + แก้ไขหลังหมดอายุ');
    await expect(page.getByText('บันทึกร่างแล้ว')).toBeVisible({ timeout: 10_000 }); // the edit made while expired saves once you are back (the autosave retries on the next change / Save)
    await page.getByRole('button', { name: 'บันทึกร่าง' }).click();
    await expect.poll(async () => (await call(page, 'GET', '/docs/QT?status=draft')).json.items?.some((i) => i.reference === 'ร่างก่อนหมดอายุ + แก้ไขหลังหมดอายุ')).toBe(true);
  });
});

test.describe('company switch with a draft open (Review Focus 5)', () => {
  test('nothing of company A is shown, saved or kept in company B', async ({ page }) => {
    await page.goto(`/sales/quotations/new?${ACC}`);
    const ref = page.getByLabel('อ้างอิง');
    await ref.fill('ลับของบริษัท-A');
    await expect(page.getByText('บันทึกร่างแล้ว')).toBeVisible(); // a draft of A exists
    await ref.fill('ลับของบริษัท-A (ยังไม่บันทึก)'); // and an unsaved edit is pending when we switch
    await page.getByRole('button', { name: /บริษัทจดทะเบียน|มะลิวัลย์/ }).first().click();
    await page.getByRole('menuitem', { name: /บ้านต้นข้าว/ }).click();
    await expect.poll(async () => (await call(page, 'GET', '/me')).json.activeCompanyId).toBe('co-nonvat');
    await expect(page.getByLabel('อ้างอิง')).toHaveValue(''); // the editor of B starts empty
    await expect(page.getByText('ลับของบริษัท-A')).toHaveCount(0);
    await page.waitForTimeout(3000); // longer than the autosave delay: a stray save would have happened by now
    const b = await call(page, 'GET', '/docs/QT?status=draft');
    expect(JSON.stringify(b.json)).not.toContain('ลับของบริษัท-A');
    await call(page, 'POST', '/me/active-company', { companyId: 'co-vat' });
    const a = await call(page, 'GET', '/docs/QT?status=draft');
    expect(a.json.items?.some((i) => i.reference === 'ลับของบริษัท-A')).toBe(true); // A kept its own draft
    expect(a.json.items?.some((i) => String(i.reference).includes('ยังไม่บันทึก'))).toBe(false);
  });
});

test.describe('profile', () => {
  test('page renders (axe), password rules, TOTP enrolment with recovery codes shown once, sessions, language', async ({ page }) => {
    await page.goto(`/profile?${ACC}`);
    await expect(page.getByRole('heading', { level: 1, name: 'โปรไฟล์ของฉัน' })).toBeVisible();
    await axeClean(page);
    await shot(page, 'hc3-profile-desktop');
    const d = await demo(page);

    // password: a wrong current one is refused in the generic style; a weak / unconfirmed new one is refused; then it changes
    await page.getByLabel('รหัสผ่านปัจจุบัน').fill('nope');
    await page.getByLabel('รหัสผ่านใหม่', { exact: true }).fill('Newpass#2026x');
    await page.getByLabel('ยืนยันรหัสผ่านใหม่').fill('Newpass#2026x');
    await page.getByRole('button', { name: 'เปลี่ยนรหัสผ่าน' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'รหัสผ่านปัจจุบันไม่ถูกต้อง' })).toBeVisible();
    await page.getByLabel('รหัสผ่านปัจจุบัน').fill(d.password);
    await page.getByLabel('รหัสผ่านใหม่', { exact: true }).fill('short');
    await page.getByLabel('ยืนยันรหัสผ่านใหม่').fill('short');
    await page.getByRole('button', { name: 'เปลี่ยนรหัสผ่าน' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'อย่างน้อย 10 ตัวอักษร' }).first()).toBeVisible();
    await page.getByLabel('รหัสผ่านใหม่', { exact: true }).fill('Newpass#2026x');
    await page.getByLabel('ยืนยันรหัสผ่านใหม่').fill('Different#2026x');
    await page.getByRole('button', { name: 'เปลี่ยนรหัสผ่าน' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'ไม่ตรงกัน' })).toBeVisible();
    await page.getByLabel('ยืนยันรหัสผ่านใหม่').fill('Newpass#2026x');
    await page.getByRole('button', { name: 'เปลี่ยนรหัสผ่าน' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'เปลี่ยนรหัสผ่านแล้ว' })).toBeVisible();
    await expect(page.getByTestId('session-row')).toHaveCount(1); // the other devices were signed out

    // TOTP enrolment
    await expect(page.getByTestId('totp-status')).toHaveText('ยังไม่ได้เปิดใช้งาน');
    await page.getByRole('button', { name: 'ตั้งค่ายืนยันตัวตนสองขั้น' }).click();
    await expect(page.getByRole('img', { name: /QR code/ })).toBeVisible();
    await expect(page.getByTestId('totp-secret')).toBeVisible();
    await axeClean(page);
    await shot(page, 'hc3-totp-enrol-desktop');
    await page.getByLabel('รหัส 6 หลัก').fill('000000');
    await page.getByRole('button', { name: 'ยืนยันและเปิดใช้งาน' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'รหัสยืนยันไม่ถูกต้อง' })).toBeVisible();
    await page.getByLabel('รหัส 6 หลัก').fill(d.totpCode);
    await page.getByRole('button', { name: 'ยืนยันและเปิดใช้งาน' }).click();
    const dlg = page.getByRole('dialog', { name: 'รหัสกู้คืน' });
    await expect(dlg.getByTestId('recovery-codes').getByRole('listitem')).toHaveCount(8);
    const codes = await dlg.getByTestId('recovery-codes').getByRole('listitem').allTextContents();
    await axeClean(page);
    await shot(page, 'hc3-recovery-codes-desktop');
    await dlg.getByRole('button', { name: 'ฉันบันทึกรหัสไว้แล้ว' }).click();
    await expect(page.getByTestId('totp-status')).toHaveText('เปิดใช้งานแล้ว · รหัสกู้คืนเหลือ 8 รหัส');
    await page.reload();
    await expect(page.getByTestId('totp-status')).toBeVisible();
    const body = await page.locator('body').innerText();
    for (const c of codes) expect(body).not.toContain(c); // shown once: nothing shows them again
    const prof = await call(page, 'GET', '/auth/profile');
    for (const c of codes) expect(JSON.stringify(prof.json)).not.toContain(c);
  });

  test('sessions: the current device is marked; ending another keeps you in; ending this one signs out', async ({ page }) => {
    await page.goto(`/profile?${ACC}`);
    await expect(page.getByTestId('session-row')).toHaveCount(3);
    await expect(page.getByTestId('session-row').filter({ hasText: 'อุปกรณ์นี้' })).toHaveCount(1);
    await page.getByTestId('session-row').filter({ hasText: 'Safari' }).getByRole('button', { name: 'ยกเลิก' }).click();
    await expect(page.getByTestId('session-row')).toHaveCount(2);
    await page.getByTestId('session-row').filter({ hasText: 'อุปกรณ์นี้' }).getByRole('button', { name: 'ออกจากระบบ' }).click();
    await expect(page).toHaveURL(/\/login$/);
  });

  test('language: TH / EN persisted in the locale cookie', async ({ page, context }) => {
    await page.goto(`/profile?${ACC}`);
    await page.getByRole('button', { name: 'English' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'My profile' })).toBeVisible();
    expect((await context.cookies()).find((c) => c.name === 'locale')?.value).toBe('en');
    await page.reload();
    await expect(page.getByRole('heading', { level: 1, name: 'My profile' })).toBeVisible();
    await page.getByRole('button', { name: 'Switch to Thai' }).or(page.getByRole('button', { name: 'เปลี่ยนเป็นภาษาไทย' })).click();
    await expect(page.getByRole('heading', { level: 1, name: 'โปรไฟล์ของฉัน' })).toBeVisible();
  });
});

test.describe('public document link', () => {
  test('the fixture links show the frozen paper with no shell; axe; an unknown token is the plain "no longer works" page', async ({ page }) => {
    await page.goto(`/p/${FIXTURE_TI_TOKEN}`);
    await expect(page.getByRole('heading', { level: 1 })).toContainText(/ใบกำกับภาษี.*TI-\d{6}-\d{4}/);
    await expect(page.getByRole('navigation')).toHaveCount(0); // no app shell
    await expect(page.locator('.paper-pill').filter({ hasText: 'สำเนา' }).first()).toBeAttached(); // the electronic copy, not a second original
    await axeClean(page);
    await shot(page, 'hc3-public-ti-desktop');
    await page.goto(`/p/${FIXTURE_QT_TOKEN}`);
    await expect(page.getByRole('heading', { level: 1 })).toContainText(/ใบเสนอราคา.*QT-/);
    await page.goto('/p/not-a-real-token');
    await expect(page.getByRole('heading', { level: 1, name: 'ลิงก์นี้ใช้ไม่ได้แล้ว' })).toBeVisible();
    await expect(page.locator('[data-screen-state="not-found"]')).toBeVisible();
    await axeClean(page);
    await shot(page, 'hc3-public-invalid-desktop');
  });

  test('ActionBar: copy makes a new random link that opens the paper; revoke ends it (and the fixture link); a cancelled document\'s link stops working', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto('/'); const id = await fixtureId(page, 'tiIssuedUnpaid');
    await page.goto(`/sales/tax-invoices/${id}?${ACC}`);
    await page.getByRole('button', { name: 'คัดลอกลิงก์สาธารณะ' }).click();
    await expect(page.getByText('คัดลอกลิงก์สาธารณะแล้ว')).toBeVisible();
    const url = await page.evaluate(() => navigator.clipboard.readText());
    expect(url).toMatch(/\/p\/[0-9a-f]{40}$/);
    expect(url).not.toContain(id);
    const pub = await context.newPage(); // a page that only has the link (the mock's "server" is this browser's storage, so it is the same context)
    await pub.goto(url);
    await expect(pub.getByRole('heading', { level: 1 })).toContainText(/TI-\d{6}-\d{4}/);
    await page.getByRole('button', { name: 'ยกเลิกลิงก์สาธารณะ' }).click();
    await expect(page.getByText(/ยกเลิกลิงก์สาธารณะแล้ว \d+ ลิงก์/)).toBeVisible();
    await pub.reload();
    await expect(pub.getByRole('heading', { level: 1, name: 'ลิงก์นี้ใช้ไม่ได้แล้ว' })).toBeVisible();
    await pub.goto(`/p/${FIXTURE_TI_TOKEN}`);
    await expect(pub.getByRole('heading', { level: 1, name: 'ลิงก์นี้ใช้ไม่ได้แล้ว' })).toBeVisible(); // revoke ends every link of the document
    await pub.close();

    // a cancelled document: its link stops working
    await page.reload();
    await page.getByRole('button', { name: 'คัดลอกลิงก์สาธารณะ' }).click();
    await expect(page.getByText('คัดลอกลิงก์สาธารณะแล้ว')).toBeVisible();
    const url2 = await page.evaluate(() => navigator.clipboard.readText());
    const doc = (await call(page, 'GET', `/docs/TI/${id}`)).json as { version: number };
    expect((await call(page, 'POST', `/docs/TI/${id}/cancel`, { version: doc.version, reasonCode: 'OTHER', reasonText: 'ทดสอบ' })).status).toBe(200);
    const pub2 = await context.newPage();
    await pub2.goto(url2);
    await expect(pub2.getByRole('heading', { level: 1, name: 'ลิงก์นี้ใช้ไม่ได้แล้ว' })).toBeVisible();
  });

  test('the button needs the document read right and a draft has none', async ({ page }) => {
    await page.goto('/'); const draft = await fixtureId(page, 'tiDraft');
    await page.goto(`/sales/tax-invoices/${draft}?${ACC}`);
    await expect(page.getByRole('button', { name: 'คัดลอกลิงก์สาธารณะ' })).toHaveCount(0);
    expect((await call(page, 'POST', `/docs/TI/${draft}/public-links`)).json).toMatchObject({ code: 'public.not_issued' });
    await page.goto(`/sales/tax-invoices?role=admin&company=vat&state=normal`); // the administrator holds no doc.TI.read
    const issued = await fixtureId(page, 'tiIssuedUnpaid');
    expect((await call(page, 'POST', `/docs/TI/${issued}/public-links`)).status).toBe(403);
  });
});

test.describe('mobile (390 px)', () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test('login, onboarding, profile and the public page have no sideways scroll', async ({ page }) => {
    const fits = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    await page.goto('/login');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    expect(await fits()).toBe(true);
    await shot(page, 'hc3-login-mobile');
    await page.goto('/onboarding');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    expect(await fits()).toBe(true);
    await shot(page, 'hc3-onboarding-mobile');
    await page.goto(`/profile?${ACC}`);
    await expect(page.getByRole('heading', { level: 1, name: 'โปรไฟล์ของฉัน' })).toBeVisible();
    expect(await fits()).toBe(true);
    await shot(page, 'hc3-profile-mobile');
    await page.goto(`/p/${FIXTURE_TI_TOKEN}`);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('TI-');
    await shot(page, 'hc3-public-mobile');
    await page.goto('/p/nope');
    await expect(page.getByRole('heading', { level: 1, name: 'ลิงก์นี้ใช้ไม่ได้แล้ว' })).toBeVisible();
    expect(await fits()).toBe(true);
    await shot(page, 'hc3-public-invalid-mobile');
  });
});
