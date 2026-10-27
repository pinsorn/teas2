import { createHmac } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';

// SP3 P10: the hybrid build (NEXT_PUBLIC_API_MODE=hybrid) against the composed stack: Postgres + migrator + API + web, run by the CI `compose` job
// (deploy/compose.ci.yml, .github/workflows/backend.yml). Routes 1-33 are answered by the real API through proxy.ts; the rest of the app is still
// the mock worker. Needs: TEAS_E2E_BASE_URL (playwright.config.ts then runs only this file), TEAS_E2E_ADMIN_EMAIL, TEAS_E2E_ADMIN_LINK (the
// one-time link `bootstrap-admin` printed; the stack was seeded with that user as admin of two companies by deploy/db/seed-ci.sql).
const BASE = process.env.TEAS_E2E_BASE_URL ?? 'http://localhost:3000';
const EMAIL = process.env.TEAS_E2E_ADMIN_EMAIL ?? '';
const LINK = process.env.TEAS_E2E_ADMIN_LINK ?? '';
const FIRST = 'Ci-First#Pass2026', SECOND = 'Ci-Second#Pass2026', INVITEE_PW = 'Ci-Invitee#Pass2026';

type Reply<T = Record<string, unknown>> = { status: number; json: T };
const call = <T = Record<string, unknown>>(page: Page, method: string, path: string, body?: unknown) =>
  page.evaluate(async ([m, p, b]) => {
    const r = await fetch(`/bff/v1${p}`, { method: m as string, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
    return { status: r.status, json: await r.json().catch(() => undefined) };
  }, [method, path, body] as const) as Promise<Reply<T>>;
type MeReply = { userId: string; activeCompanyId: string | null; memberships: { companyId: string; companyName: string; roleId: string }[]; permissions: string[] };

/** RFC 6238, SHA-1, 6 digits, 30 s: what an authenticator app computes from the secret shown at enrolment. */
function totp(secret: string, at = Date.now()): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const bits = [...secret.toUpperCase().replace(/[^A-Z2-7]/g, '')].map((c) => alphabet.indexOf(c).toString(2).padStart(5, '0')).join('');
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const h = createHmac('sha1', key).update(counter).digest();
  const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

async function setPassword(page: Page, linkPath: string, password: string) {
  await page.goto(linkPath);
  await page.getByLabel('รหัสผ่านใหม่', { exact: true }).fill(password);
  await page.getByLabel('ยืนยันรหัสผ่านใหม่').fill(password);
  await page.getByRole('button', { name: 'ตั้งรหัสผ่าน' }).click();
  await expect(page.getByTestId('link-done')).toBeVisible();
}
async function signIn(page: Page, email: string, password: string) {
  await page.goto('/login');
  await page.getByLabel('อีเมล').fill(email);
  await page.getByLabel('รหัสผ่าน').fill(password);
  await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click();
}

test.skip(!EMAIL || !LINK, 'needs the composed stack (TEAS_E2E_ADMIN_EMAIL, TEAS_E2E_ADMIN_LINK)');

test('hybrid: the platform routes are live, the rest of the app is still the mock', async ({ page, browser }) => {
  test.setTimeout(240_000);
  const linkPath = new URL(LINK, BASE).pathname; // the link was minted for TEAS_PUBLIC_URL; the page is served at BASE

  await test.step('the bootstrap link sets the first password (route 13 + 14), once', async () => {
    await page.goto(linkPath);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByText(EMAIL).first()).toBeVisible();
    await setPassword(page, linkPath, FIRST);
    await page.goto(linkPath);
    await expect(page.getByTestId('link-invalid')).toBeVisible(); // spent
  });

  await test.step('sign in (route 1): the session is the API\'s, with two memberships (15)', async () => {
    await signIn(page, EMAIL, FIRST);
    await expect(page).toHaveURL(/\/$/);
    const me = (await call<MeReply>(page, 'GET', '/me')).json;
    expect(me.memberships).toHaveLength(2);
    expect(me.activeCompanyId).toBeTruthy();
    expect(me.permissions).toContain('users.manage');
    expect((await page.context().cookies()).some((c) => c.name === '__Host-teas_session' && c.httpOnly)).toBe(true); // Set-Cookie passed through the BFF
  });

  await test.step('switch company from the shell (route 16)', async () => {
    const me = (await call<MeReply>(page, 'GET', '/me')).json;
    const active = me.memberships.find((m) => m.companyId === me.activeCompanyId)!;
    const other = me.memberships.find((m) => m.companyId !== me.activeCompanyId)!;
    await page.getByRole('button', { name: new RegExp(active.companyName) }).first().click();
    await page.getByRole('menuitem', { name: new RegExp(other.companyName) }).click();
    await expect.poll(async () => (await call<MeReply>(page, 'GET', '/me')).json.activeCompanyId).toBe(other.companyId);
  });

  await test.step('change the password (route 8): a wrong current one is refused, then it changes', async () => {
    await page.goto('/profile');
    await expect(page.getByRole('heading', { level: 1, name: 'โปรไฟล์ของฉัน' })).toBeVisible();
    await page.getByLabel('รหัสผ่านปัจจุบัน').fill('not-the-password');
    await page.getByLabel('รหัสผ่านใหม่', { exact: true }).fill(SECOND);
    await page.getByLabel('ยืนยันรหัสผ่านใหม่').fill(SECOND);
    await page.getByRole('button', { name: 'เปลี่ยนรหัสผ่าน' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'รหัสผ่านปัจจุบันไม่ถูกต้อง' })).toBeVisible();
    await page.getByLabel('รหัสผ่านปัจจุบัน').fill(FIRST);
    await page.getByRole('button', { name: 'เปลี่ยนรหัสผ่าน' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'เปลี่ยนรหัสผ่านแล้ว' })).toBeVisible();
  });

  let recovery: string[] = [];
  await test.step('enrol TOTP (routes 9 + 10): a real QR, the secret, a code computed from it, recovery codes shown once', async () => {
    await page.getByRole('button', { name: 'ตั้งค่ายืนยันตัวตนสองขั้น' }).click();
    await expect(page.getByRole('img', { name: 'QR code' })).toBeVisible();
    const secret = (await page.getByTestId('totp-secret').textContent())!;
    expect(secret).toMatch(/^[A-Z2-7]{16,}$/);
    expect(await page.getByRole('img', { name: 'QR code' }).locator('path').getAttribute('d')).toMatch(/^M\d+ \d+h1v1h-1z/); // modules, not a placeholder
    await page.getByLabel('รหัส 6 หลัก').fill('000000');
    await page.getByRole('button', { name: 'ยืนยันและเปิดใช้งาน' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'รหัสยืนยันไม่ถูกต้อง' })).toBeVisible();
    await page.getByLabel('รหัส 6 หลัก').fill(totp(secret));
    await page.getByRole('button', { name: 'ยืนยันและเปิดใช้งาน' }).click();
    const dlg = page.getByRole('dialog', { name: 'รหัสกู้คืน' });
    await expect(dlg.getByTestId('recovery-codes').getByRole('listitem')).toHaveCount(8);
    recovery = await dlg.getByTestId('recovery-codes').getByRole('listitem').allTextContents();
    await dlg.getByRole('button', { name: 'ฉันบันทึกรหัสไว้แล้ว' }).click();
    await expect(page.getByTestId('totp-status')).toContainText('เปิดใช้งานแล้ว');
  });

  await test.step('sign out (route 5) and back in with the new password and a recovery code (routes 1 + 2)', async () => {
    expect((await call(page, 'POST', '/auth/logout')).json).toEqual({ state: 'out' });
    expect((await call(page, 'GET', '/auth/session')).json).toEqual({ state: 'out' });
    await signIn(page, EMAIL, SECOND);
    await expect(page).toHaveURL(/\/login\/totp$/);
    await page.getByRole('button', { name: 'ใช้รหัสกู้คืนแทน' }).click();
    await page.getByLabel('รหัสกู้คืน').fill(recovery[0]);
    await page.getByRole('button', { name: 'ยืนยัน' }).click();
    await expect(page).toHaveURL(/\/$/);
  });

  const inviteeEmail = `invitee-${Date.now()}@ci.example.test`;
  await test.step('invite a user (routes 20 + 21), who sets a password through the link in a fresh browser (13 + 14)', async () => {
    const roles = (await call<{ items: { id: string; name: string }[] }>(page, 'GET', '/settings/roles')).json.items;
    const role = roles.find((r) => r.id !== 'admin') ?? roles[0];
    const made = await call<{ id: string; link: string }>(page, 'POST', '/settings/users', { name: 'ผู้ใช้ทดสอบ CI', email: inviteeEmail, roleId: role.id });
    expect(made.status).toBe(201);
    const token = made.json.link.split('/link/')[1];
    expect(token).toMatch(/^[\w-]{16,}$/);
    expect(JSON.stringify((await call(page, 'GET', '/settings/users')).json)).not.toContain(token); // shown once

    const ctx = await browser.newContext({ baseURL: BASE, locale: 'th-TH' });
    try {
      const guest = await ctx.newPage();
      await setPassword(guest, `/link/${token}`, INVITEE_PW);
      await signIn(guest, inviteeEmail, INVITEE_PW);
      await expect(guest).toHaveURL(/\/$/);
      const me = (await call<MeReply>(guest, 'GET', '/me')).json;
      expect(me.memberships).toHaveLength(1);
    } finally { await ctx.close(); }
  });

  await test.step('create, rotate and revoke an API key (routes 30-33): the secret is shown once', async () => {
    await page.goto('/settings/connect');
    await expect(page.getByRole('heading', { level: 1, name: 'TEAS Connect' })).toBeVisible();
    const table = page.getByRole('table', { name: 'คีย์ API' });
    await page.getByRole('button', { name: 'สร้างคีย์' }).click();
    const form = page.getByRole('dialog', { name: 'สร้างคีย์ API' });
    await form.getByLabel('ชื่อคีย์').fill('คีย์ทดสอบ CI');
    await form.getByRole('checkbox').first().check();
    await form.getByRole('button', { name: 'สร้างคีย์' }).click();
    const once = page.getByRole('dialog', { name: /คีย์ใหม่: คีย์ทดสอบ CI/ });
    const secret = (await once.getByTestId('secret-once').textContent())!;
    expect(secret).toMatch(/^teas_\w+_[0-9a-f]{48}$/);
    await once.getByRole('button', { name: 'ฉันเก็บคีย์แล้ว' }).click();
    await expect(table.getByRole('row', { name: /คีย์ทดสอบ CI/ })).toContainText(secret.slice(0, 14));
    expect(JSON.stringify((await call(page, 'GET', '/connect/keys')).json)).not.toContain(secret.slice(14));

    await page.getByRole('button', { name: 'หมุนเวียนคีย์ คีย์ทดสอบ CI' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'หมุนเวียนคีย์' }).click();
    const second = page.getByRole('dialog', { name: /คีย์ใหม่: คีย์ทดสอบ CI/ });
    const secret2 = (await second.getByTestId('secret-once').textContent())!;
    expect(secret2).not.toBe(secret);
    await second.getByRole('button', { name: 'ฉันเก็บคีย์แล้ว' }).click();
    await expect(table.getByRole('row', { name: /คีย์ทดสอบ CI/ }).filter({ hasText: 'เพิกถอนแล้ว' })).toHaveCount(1); // the old one

    await page.getByRole('button', { name: 'เพิกถอนคีย์ คีย์ทดสอบ CI' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'เพิกถอนคีย์' }).click();
    await expect(table.getByRole('row', { name: /คีย์ทดสอบ CI/ }).filter({ hasText: 'เพิกถอนแล้ว' })).toHaveCount(2);
  });

  await test.step('the rest of the app is still the mock worker (hybrid), the mock-only routes are not live', async () => {
    expect((await call(page, 'GET', '/connect/apps')).status).toBe(200); // route not in LIVE_ROUTES: answered in the browser
    expect((await call(page, 'GET', '/auth/demo')).status).toBe(200); // F11: mock only
    await page.goto('/settings/connect?tab=apps');
    await expect(page.getByRole('heading', { level: 1, name: 'TEAS Connect' })).toBeVisible();
  });

  await test.step('S7 against the real stack: a cross-origin or non-JSON POST is refused by the BFF before the API sees it', async () => {
    const r = await page.evaluate(async () => {
      const wrongType = await fetch('/bff/v1/auth/logout', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
      const form = await fetch('/bff/v1/auth/logout', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'a=b' });
      return [wrongType.status, form.status];
    });
    expect(r).toEqual([403, 403]);
    expect((await call(page, 'GET', '/auth/session')).json).toMatchObject({ state: 'active' }); // and it did not sign anybody out
  });
});
