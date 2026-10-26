import { expect, test, type Page } from '@playwright/test';
import { axeClean } from './helpers/axe';
import { fixtureId } from './helpers/fixtures';
import { screenContract } from './helpers/screen-contract';

const shot = async (page: Page, name: string) => { if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/${name}.png`, fullPage: true }); };
const ADMIN = 'role=admin&company=vat&state=normal';
const ACC = 'role=accountant&company=vat&state=normal';
const noSideScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
const call = (page: Page, method: string, path: string, body?: unknown) =>
  page.evaluate(async ([m, p, b]) => { const r = await fetch(`/bff/v1${p}`, { method: m as string, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, json: await r.json() }; }, [method, path, body] as const) as Promise<{ status: number; json: Record<string, unknown> }>;

// HC2a: any member has their own keys; the connected apps and the agent policy are the administrator's (connect.manage)
screenContract({ name: 'connect keys', path: '/settings/connect', heading: 'TEAS Connect', company: 'both', roles: ['admin', 'accountant'], states: ['loading', 'error', 'forbidden'] });
for (const [tab, path] of [['apps', '/settings/connect?tab=apps'], ['policy', '/settings/connect?tab=policy']] as const) {
  screenContract({ name: `connect ${tab}`, path, heading: 'TEAS Connect', company: 'both', roles: ['admin'], states: ['loading', 'error', 'forbidden'], forbiddenRole: 'accountant' });
}
// the stored review report of the agent's draft: read with the document type's right (the administrator holds none); the other company has no such report
screenContract({ name: 'agent report', path: '/agent-reports/ar-1', heading: 'รายงานการตรวจของ agent', company: 'vat', otherCompany: 'not-found', states: ['loading', 'error', 'forbidden'], forbiddenRole: 'admin' });
// the consent page lives outside the app shell
screenContract({ name: 'oauth consent', path: '/oauth/consent?client=cl-assistant', heading: /ขอเชื่อมต่อกับบริษัทของคุณ/, company: 'both', roles: ['admin', 'accountant'], states: ['loading', 'error', 'forbidden'] }); // any active member may connect an agent for themselves

test.beforeEach(async ({ page }) => { await page.goto('/'); await page.evaluate(() => localStorage.clear()); await page.reload(); });

test('API keys: create shows the secret once, rotate revokes the old key, revoke is final; no list response ever carries a secret', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto(`/settings/connect?${ADMIN}`);
  await expect(page.getByRole('heading', { level: 1, name: 'TEAS Connect' })).toBeVisible();
  const table = page.getByRole('table', { name: 'คีย์ API' });
  await expect(table.getByRole('row')).toHaveCount(3); // header + the two seeded keys
  await shot(page, 'hc2-keys-desktop');

  await page.getByRole('button', { name: 'สร้างคีย์' }).click();
  const form = page.getByRole('dialog', { name: 'สร้างคีย์ API' });
  await form.getByRole('button', { name: 'สร้างคีย์' }).click(); // empty form: field errors, nothing created
  await expect(form.getByText('ต้องระบุชื่อคีย์')).toBeVisible();
  await expect(form.getByText('ต้องเลือกสิทธิ์อย่างน้อยหนึ่งรายการ')).toBeVisible();
  await form.getByLabel('ชื่อคีย์').fill('ผู้ช่วยทดสอบ');
  await form.getByLabel('ดูรายงาน', { exact: true }).check();
  await shot(page, 'hc2-key-form-desktop');
  await form.getByRole('button', { name: 'สร้างคีย์' }).click();

  const once = page.getByRole('dialog', { name: /คีย์ใหม่: ผู้ช่วยทดสอบ/ });
  const secret = (await once.getByTestId('secret-once').textContent())!;
  expect(secret).toMatch(/^teas_mcp_[0-9a-f]{48}$/);
  await once.getByRole('button', { name: 'คัดลอกคีย์' }).click();
  await expect(once.getByText('คัดลอกแล้ว')).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(secret);
  await axeClean(page);
  await shot(page, 'hc2-secret-once-desktop');
  await page.keyboard.press('Escape');
  await expect(once).toBeVisible(); // closing is only through the button
  await once.getByRole('button', { name: 'ฉันเก็บคีย์แล้ว' }).click();
  await expect(once).toHaveCount(0);
  await expect(page.getByText(secret, { exact: false })).toHaveCount(0); // the list shows the prefix, never the secret
  await expect(table.getByRole('row', { name: /ผู้ช่วยทดสอบ/ })).toContainText(secret.slice(0, 14));
  const list = JSON.stringify((await call(page, 'GET', '/connect/keys')).json);
  expect(list).not.toContain(secret.slice(14));

  // rotate: confirm, a NEW secret, the old key is revoked
  await page.getByRole('button', { name: 'หมุนเวียนคีย์ ผู้ช่วยทดสอบ' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'หมุนเวียนคีย์' }).click();
  const second = page.getByRole('dialog', { name: /คีย์ใหม่: ผู้ช่วยทดสอบ/ });
  const secret2 = (await second.getByTestId('secret-once').textContent())!;
  expect(secret2).not.toBe(secret);
  await second.getByRole('button', { name: 'ฉันเก็บคีย์แล้ว' }).click();
  await expect(table.getByRole('row', { name: /ผู้ช่วยทดสอบ/ })).toHaveCount(2);
  await expect(table.getByRole('row', { name: /ผู้ช่วยทดสอบ/ }).filter({ hasText: 'เพิกถอนแล้ว' })).toHaveCount(1);
  expect(JSON.stringify((await call(page, 'GET', '/connect/keys')).json)).not.toContain(secret2.slice(14));

  // revoke: a destructive confirm
  await page.getByRole('button', { name: 'เพิกถอนคีย์ ผู้ช่วยทดสอบ' }).click();
  await shot(page, 'hc2-revoke-confirm-desktop');
  await page.getByRole('alertdialog').getByRole('button', { name: 'เพิกถอนคีย์' }).click();
  await expect(table.getByRole('row', { name: /ผู้ช่วยทดสอบ/ }).filter({ hasText: 'เพิกถอนแล้ว' })).toHaveCount(2);
  await expect(page.getByRole('button', { name: /เพิกถอนคีย์ ผู้ช่วยทดสอบ/ })).toHaveCount(0);
});

test('API keys: a scope beyond the owner is refused by the server; an agent cannot create a key', async ({ page }) => {
  await page.goto(`/settings/connect?${ADMIN}`);
  await expect(page.getByRole('heading', { level: 1, name: 'TEAS Connect' })).toBeVisible();
  const over = await call(page, 'POST', '/connect/keys', { name: 'x', kind: 'rest', scopes: ['doc.TI.create'] }); // the administrator holds no TI right
  expect([over.status, over.json.code]).toEqual([422, 'connect.scope_exceeds']);
  const forbidden = await call(page, 'POST', '/connect/keys', { name: 'x', kind: 'rest', scopes: ['settings.manage'] });
  expect([forbidden.status, forbidden.json.code]).toEqual([422, 'connect.scope_forbidden']);
});

test('a member (the accountant) has their own keys tab only; approve / cancel / correct scopes are never allowed, even for a right they hold', async ({ page }) => {
  await page.goto(`/settings/connect?${ACC}`);
  await expect(page.getByRole('heading', { level: 1, name: 'TEAS Connect' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'คีย์ API' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'แอปที่เชื่อมต่อ' })).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'นโยบาย agent' })).toHaveCount(0);
  await expect(page.getByText('คีย์ของคุณเอง')).toBeVisible();
  await page.getByRole('button', { name: 'สร้างคีย์' }).click();
  const form = page.getByRole('dialog', { name: 'สร้างคีย์ API' });
  await form.getByLabel('ชื่อคีย์').fill('ผู้ช่วยออกใบกำกับ');
  await expect(form.getByLabel(/อนุมัติ/)).toHaveCount(0); // approve / cancel / correct are not even offered
  await form.getByLabel('สร้างใบกำกับภาษี', { exact: true }).check();
  await form.getByRole('button', { name: 'สร้างคีย์' }).click();
  await expect(page.getByRole('dialog', { name: /คีย์ใหม่: ผู้ช่วยออกใบกำกับ/ }).getByTestId('secret-once')).toContainText('teas_mcp_');
  for (const sc of ['doc.TI.approve', 'doc.TI.cancel', 'doc.PB.correct']) {
    const r = await call(page, 'POST', '/connect/keys', { name: 'x', kind: 'rest', scopes: [sc] });
    expect([sc, r.status, r.json.code]).toEqual([sc, 422, 'connect.scope_forbidden']);
  }
  expect((await call(page, 'GET', '/connect/apps')).status).toBe(403);
  await shot(page, 'hc2a-member-keys-desktop');
});

test('connected apps: the list and a confirmed revoke', async ({ page }) => {
  await page.goto(`/settings/connect?tab=apps&${ADMIN}`);
  const table = page.getByRole('table', { name: 'แอปที่เชื่อมต่อ' });
  await expect(table).toContainText('Claude Desktop');
  await shot(page, 'hc2-apps-desktop');
  await page.getByRole('button', { name: 'ถอนสิทธิ์แอป Claude Desktop' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'ถอนสิทธิ์' }).click();
  await expect(page.getByText('ยังไม่มีแอปที่เชื่อมต่อ')).toBeVisible();
});

test('agent policy: T-class cannot be Auto, a save is kept, the hard limits are a read-only list', async ({ page }) => {
  await page.goto(`/settings/connect?tab=policy&${ADMIN}`);
  const ti = page.getByRole('combobox', { name: 'นโยบายของ ใบกำกับภาษี' });
  await expect(ti).toHaveValue('human');
  await expect(ti.getByRole('option', { name: 'อัตโนมัติถ้าไม่มีข้อสังเกต' })).toBeDisabled();
  const pv = page.getByRole('combobox', { name: 'นโยบายของ ใบสำคัญจ่าย' });
  await expect(pv).toHaveValue('auto');
  await page.getByRole('textbox', { name: 'วงเงินของ ใบสำคัญจ่าย' }).fill('20000');
  await page.getByRole('button', { name: 'บันทึก ใบสำคัญจ่าย' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'บันทึกแล้ว' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('textbox', { name: 'วงเงินของ ใบสำคัญจ่าย' })).toHaveValue('20000.00');
  await expect(page.getByTestId('hard-limits').getByRole('listitem')).toHaveCount(9);
  await expect(page.getByTestId('hard-limits')).toContainText('ปิดหรือเปิดงวดบัญชี');
  await shot(page, 'hc2-policy-desktop');
  const t = await call(page, 'PUT', '/connect/policy/TI', { mode: 'auto', cap: '1.00', version: 1 });
  expect([t.status, t.json.code]).toEqual([422, 'agent.policy_t_class']);
});

test('the agent report: the stored checks by severity, the route, the totals and the journal rules; linked from Home and from the draft', async ({ page }) => {
  await page.goto(`/?${ACC}`);
  const link = page.getByRole('link', { name: 'ดูรายงานการตรวจ' }).first();
  await expect(link).toBeVisible();
  await link.click();
  await expect(page.getByRole('heading', { level: 1, name: 'รายงานการตรวจของ agent' })).toBeVisible();
  await expect(page.getByTestId('report-for-version')).toContainText('รายงานนี้สำหรับฉบับที่');
  await expect(page.getByTestId('report-moved')).toHaveCount(0); // the document has not moved on
  await expect(page.getByText('รอคนอนุมัติ')).toBeVisible();
  await expect(page.getByRole('heading', { name: /ข้อผิดพลาด/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: /คำเตือน/ })).toBeVisible();
  await expect(page.locator('[data-check="totals"]')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'ตัวอย่างการลงบัญชี' })).toBeVisible();
  await expect(page.getByRole('cell', { name: /ประเภทเอกสาร|ค่าเริ่มต้น|หมวด|สินค้า/ }).first()).toBeVisible(); // the rule that chose an account
  await axeClean(page);
  await shot(page, 'hc2-agent-report-desktop');
  // the draft's banner links the same report
  const id = await fixtureId(page, 'tiAgentDraft');
  await page.goto(`/sales/tax-invoices/${id}?${ACC}`);
  await expect(page.getByTestId('agent-banner').getByRole('link', { name: 'ดูรายงานการตรวจ' })).toHaveAttribute('href', /^\/agent-reports\/ar-\d+$/);
  await page.getByRole('tab', { name: 'กิจกรรม' }).click(); // and so does the timeline entry
  await expect(page.getByRole('link', { name: 'ดูรายงานการตรวจ' }).last()).toHaveAttribute('href', /^\/agent-reports\/ar-\d+$/);
  await shot(page, 'hc2a-timeline-desktop');
});

test('consent: no app shell; the company and the owner\'s limits are shown; approve connects, deny does not', async ({ page }) => {
  await page.goto(`/oauth/consent?client=cl-assistant&${ADMIN}`);
  await expect(page.getByRole('heading', { level: 1, name: /ผู้ช่วยบัญชี \(AI\) ขอเชื่อมต่อ/ })).toBeVisible();
  await expect(page.getByRole('navigation')).toHaveCount(0); // no sidebar, no top bar
  await expect(page.locator('aside, header')).toHaveCount(0);
  await expect(page.getByText(/บริษัท .* · เจ้าของ/)).toBeVisible();
  await expect(page.getByTestId('granted')).toContainText('ดูรายงาน');
  await expect(page.getByTestId('not-granted')).toContainText('จัดการการตั้งค่า'); // asked for, a §8.5 right: never granted
  await axeClean(page);
  await shot(page, 'hc2-consent-desktop');
  await page.getByRole('button', { name: 'ไม่อนุญาต' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'ไม่อนุญาตการเชื่อมต่อ' })).toBeVisible();
  await page.goto(`/settings/connect?tab=apps&${ADMIN}`);
  await expect(page.getByRole('table', { name: 'แอปที่เชื่อมต่อ' }).getByRole('row')).toHaveCount(2); // header + Claude Desktop: nothing was connected
  await page.goto(`/oauth/consent?client=cl-assistant&${ADMIN}`);
  await page.getByRole('button', { name: 'อนุญาต', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: /เชื่อมต่อ ผู้ช่วยบัญชี \(AI\) แล้ว/ })).toBeVisible();
  await page.getByRole('link', { name: 'ไปที่แอปที่เชื่อมต่อ' }).click();
  await expect(page.getByRole('table', { name: 'แอปที่เชื่อมต่อ' })).toContainText('ผู้ช่วยบัญชี (AI)');
});

test.describe('mobile 390', () => {
  test.use({ viewport: { width: 390, height: 844 } });
  for (const [name, path] of [['keys', 'settings/connect'], ['apps', 'settings/connect?tab=apps'], ['policy', 'settings/connect?tab=policy']] as const) {
    test(`${name} tab fits the viewport`, async ({ page }) => {
      await page.goto(`/${path}${path.includes('?') ? '&' : '?'}${ADMIN}`);
      await expect(page.getByRole('heading', { level: 1, name: 'TEAS Connect' })).toBeVisible();
      await expect(page.locator('[data-screen-state="loading"]')).toHaveCount(0);
      expect(await noSideScroll(page)).toBe(true);
      await axeClean(page);
      await shot(page, `hc2-${name}-mobile`);
    });
  }
  test('report and consent fit the viewport', async ({ page }) => {
    await page.goto(`/agent-reports/ar-1?${ACC}`);
    await expect(page.getByRole('heading', { level: 1, name: 'รายงานการตรวจของ agent' })).toBeVisible();
    expect(await noSideScroll(page)).toBe(true);
    await shot(page, 'hc2-agent-report-mobile');
    await page.goto(`/oauth/consent?client=cl-assistant&${ADMIN}`);
    await expect(page.getByRole('button', { name: 'อนุญาต', exact: true })).toBeVisible();
    expect(await noSideScroll(page)).toBe(true);
    await shot(page, 'hc2-consent-mobile');
  });
});
