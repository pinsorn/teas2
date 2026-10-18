import { expect, test, type Page } from '@playwright/test';
import { axeClean } from './helpers/axe';
import { fixtureId } from './helpers/fixtures';
import { screenContract } from './helpers/screen-contract';

const PR = '/payroll/runs', EMP = '/payroll/employees';
const STATES = ['empty', 'loading', 'error', 'forbidden'] as const;
const shot = async (page: Page, name: string) => { if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/${name}.png`, fullPage: true }); };

// payroll belongs to the accountant (employee.read / doc.PR.*): the operator is forbidden on every screen
screenContract({ name: 'employees list', path: EMP, heading: 'พนักงาน', company: 'both', states: [...STATES], forbiddenRole: 'operator' });
screenContract({ name: 'employee (the joiner)', path: async (p) => `${EMP}/${await fixtureId(p, 'empJoiner')}`, heading: 'ธนา เริ่มงานใหม่', company: 'vat', otherCompany: 'not-found', states: ['loading', 'error', 'forbidden'], forbiddenRole: 'operator' });
screenContract({ name: 'payroll runs list', path: PR, heading: 'รอบเงินเดือน', company: 'both', states: [...STATES], forbiddenRole: 'operator' });
screenContract({ name: 'payroll run (issued)', path: async (p) => `${PR}/${await fixtureId(p, 'prIssued')}`, heading: /PR-\d{6}-\d{4}/, company: 'vat', otherCompany: 'not-found', states: ['loading', 'error', 'forbidden'], forbiddenRole: 'operator' });
screenContract({ name: 'payroll run (locked by a later run)', path: async (p) => `${PR}/${await fixtureId(p, 'prPaid')}`, heading: /PR-\d{6}-\d{4}/, company: 'vat', otherCompany: 'not-found', states: ['loading', 'error', 'forbidden'] });
screenContract({ name: 'payroll run (non-VAT company)', path: async (p) => `${PR}/${await fixtureId(p, 'nprIssued')}`, heading: /PR-\d{6}-\d{4}/, company: 'nonvat', otherCompany: 'not-found', states: ['loading', 'error', 'forbidden'] });
screenContract({ name: 'payroll run new', path: `${PR}/new`, heading: 'สร้างรอบเงินเดือน', company: 'both', states: ['loading', 'error'] });

test.beforeEach(async ({ page }) => { await page.goto('/'); await page.evaluate(() => localStorage.clear()); await page.reload(); });

const api = <T,>(page: Page, path: string) => page.evaluate(async (p) => (await fetch(`/bff/v1${p}`)).json(), path) as Promise<T>;
const send = (page: Page, method: string, path: string, body?: unknown) => page.evaluate(async ([m, p, b]) => {
  const r = await fetch(`/bff/v1${p as string}`, { method: m as string, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, json: await r.json().catch(() => undefined) } as { status: number; json: { code?: string; id?: string; version?: number } };
}, [method, path, body] as const);
const money = (t: string | null) => Math.round(Number((t ?? '').replace(/,/g, '')) * 100);

test('open the October draft, add overtime to one employee: the server recomputes PIT and net beside it; issue the run and the later-run lock appears on September', async ({ page }) => {
  await page.goto('/');
  const draft = await fixtureId(page, 'prDraft'), bonus = await fixtureId(page, 'prIssued'); // resolved before the draft is issued (a fixture is a state)
  await page.goto(`${PR}/${draft}/edit`);
  const rows = page.getByTestId('payroll-row');
  await expect(rows).toHaveCount(4); // emp-01 .. emp-04 (emp-05 left in September)
  const first = rows.filter({ hasText: 'สมศรี บัญชีดี' });
  await expect(first.getByTestId('slip-net')).not.toHaveText(''); // the server's answer has landed
  await expect(first.getByTestId('slip-net')).not.toHaveText('…');
  const pit0 = money(await first.getByTestId('slip-pit').textContent()), net0 = money(await first.getByTestId('slip-net').textContent());
  expect(money(await first.getByTestId('slip-gross').textContent())).toBe(12000000);
  // the joiner is prorated by the server: 17 of 31 days
  const joiner = rows.filter({ hasText: 'ธนา เริ่มงานใหม่' });
  await expect(joiner.getByTestId('payroll-prorated')).toContainText('17 วัน');
  await expect(joiner.getByTestId('slip-gross')).toHaveText('13,709.68');
  // overtime 50,000.00: gross, PIT and net all come back from the server
  await first.getByRole('textbox', { name: 'ค่าล่วงเวลา (OT) สมศรี บัญชีดี' }).fill('50000');
  await expect(first.getByTestId('slip-gross')).toHaveText('170,000.00');
  await expect(first.getByTestId('slip-net')).not.toHaveText(/^$/);
  await expect.poll(async () => money(await first.getByTestId('slip-pit').textContent())).toBeGreaterThan(pit0);
  const pit1 = money(await first.getByTestId('slip-pit').textContent()), sso1 = money(await first.getByTestId('slip-sso').textContent()), net1 = money(await first.getByTestId('slip-net').textContent());
  expect(net1).toBe(17000000 - pit1 - sso1); // the identity holds on what the server returned (the page never computed it)
  expect(net1).toBeGreaterThan(net0);
  await shot(page, 'payroll-editor-desktop');
  await axeClean(page);
  await page.getByRole('button', { name: 'ออกรอบเงินเดือน' }).click();
  const dlg = page.getByRole('alertdialog');
  await expect(dlg).toContainText('ประกันสังคมนายจ้างสมทบ');
  await expect(dlg).toContainText('จ่ายสุทธิ');
  await page.getByRole('alertdialog').getByRole('button', { name: /^ออก/ }).click();
  await expect(page.getByTestId('doc-number')).toHaveText(/^PR-202610-\d{4}$/);
  await expect(page.getByTestId('payroll-summary-row')).toHaveCount(4);
  await shot(page, 'payroll-issued');
  // the ledger tab: the run's journal
  await page.getByRole('tab', { name: 'ผลต่อบัญชี' }).click();
  const tab = page.getByRole('tabpanel');
  for (const code of ['5400', '5410', '2153', '2160', '2170']) await expect(tab).toContainText(code);
  // the bonus run of September now has a later run holding its employees: revising or cancelling it is refused, and its page says why
  const b = await api<{ version: number; header: unknown; lines: unknown[] }>(page, `/docs/PR/${bonus}`);
  const r = await send(page, 'POST', `/docs/PR/${bonus}/cancel`, { version: b.version, reasonCode: 'OTHER', reasonText: 'x' });
  expect([r.status, r.json.code]).toEqual([409, 'payroll.later_run']);
  await page.goto(`${PR}/${bonus}`);
  await expect(page.locator('[data-screen-state="locked"]')).toContainText('มีรอบเงินเดือนที่ออกภายหลัง');
  await expect(page.getByRole('button', { name: 'ยกเลิกเอกสาร' })).toBeDisabled();
});

test('the locked September run and its exits; the frozen payslips name the table they used', async ({ page }) => {
  await page.goto('/'); const id = await fixtureId(page, 'prPaid');
  await page.goto(`${PR}/${id}`);
  const lock = page.locator('[data-screen-state="locked"]');
  await expect(lock).toContainText('PR-202609-0001');
  await expect(lock).toContainText('แก้ไขในรอบถัดไปด้วยรายการปรับปรุง (รายได้อื่น / รายการหักอื่น)');
  await expect(page.getByTestId('payroll-summary')).toContainText('sp-r-2026-1');
  await expect(page.getByTestId('payroll-summary-row')).toHaveCount(4);
  await shot(page, 'payroll-locked');
  await axeClean(page);
});

test('mobile: the editor is cards, every control is reachable and nothing scrolls sideways', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/'); const draft = await fixtureId(page, 'prDraft');
  await page.goto(`${PR}/${draft}/edit`);
  await expect(page.getByTestId('payroll-row')).toHaveCount(4);
  await expect(page.getByTestId('payroll-row').first().getByTestId('slip-net')).not.toHaveText('…');
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(over).toBeLessThanOrEqual(0);
  await shot(page, 'payroll-editor-mobile');
  await axeClean(page);
  await page.getByTestId('payroll-row').first().getByRole('textbox', { name: /^โบนัส/ }).fill('1000');
  await expect(page.getByTestId('payroll-row').first().getByTestId('slip-gross')).toHaveText('121,000.00');
});

test('create an employee with a bad national ID (checksum), fix it, and see the employee in the list', async ({ page }) => {
  await page.goto(EMP);
  await expect(page.getByRole('link', { name: 'E05' })).toBeVisible();
  await page.getByRole('button', { name: 'เพิ่มพนักงาน' }).click();
  const dlg = page.getByRole('dialog', { name: 'เพิ่มพนักงาน' });
  await dlg.getByLabel('รหัส').fill('E09');
  await dlg.getByLabel('ชื่อ', { exact: true }).fill('ทดลอง');
  await dlg.getByLabel('นามสกุล').fill('ระบบเงินเดือน');
  await dlg.getByLabel('เลขบัตรประจำตัวประชาชน').fill('1100700009902'); // wrong last digit
  await dlg.getByLabel('วันที่เริ่มงาน').fill('2026-10-01');
  await dlg.getByLabel('เงินเดือน (บาท/เดือน)').fill('20000');
  await dlg.getByRole('button', { name: 'บันทึก' }).click();
  await expect(dlg.getByText('เลขประจำตัวผู้เสียภาษีไม่ถูกต้อง')).toBeVisible();
  await dlg.getByLabel('เลขบัตรประจำตัวประชาชน').fill('1100700009903');
  await dlg.getByRole('button', { name: 'บันทึก' }).click();
  await expect(dlg).toBeHidden();
  await expect(page.getByRole('link', { name: 'E09' })).toBeVisible();
  // the new employee is in the next run from the first row on: the new-run page starts with the month's employees
  await page.goto(`${PR}/new`);
  await expect(page.getByText('ทดลอง ระบบเงินเดือน')).toBeVisible();
});
