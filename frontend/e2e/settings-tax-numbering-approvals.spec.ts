import { expect, test, type Page } from '@playwright/test';
import { axeClean } from './helpers/axe';
import { screenContract } from './helpers/screen-contract';

const shot = async (page: Page, name: string) => { if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/${name}.png`, fullPage: true }); };
const ACC = 'role=accountant&company=vat&state=normal';
const ADMIN = 'role=admin&company=vat&state=normal';
const api = <T,>(page: Page, path: string) => page.evaluate(async (p) => (await fetch(`/bff/v1${p}`)).json(), path) as Promise<T>;
const noSideScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

// tax settings are the accountant's (tax.settings.manage; the operator has none); numbering and approvals are settings (settings.manage: admin only)
screenContract({ name: 'tax settings', path: '/settings/tax', heading: 'ภาษี', company: 'both', states: ['loading', 'error', 'forbidden'], forbiddenRole: 'operator' });
screenContract({ name: 'numbering settings', path: '/settings/numbering', heading: 'เลขที่เอกสาร', company: 'both', roles: ['admin'], states: ['loading', 'error', 'forbidden'], forbiddenRole: 'accountant' });
screenContract({ name: 'approval settings', path: '/settings/approvals', heading: 'การอนุมัติ', company: 'both', roles: ['admin'], states: ['loading', 'error', 'forbidden'], forbiddenRole: 'accountant' });

test.beforeEach(async ({ page }) => { await page.goto('/'); await page.evaluate(() => localStorage.clear()); await page.reload(); });

test('tax: "change the rate" adds a dated row and history shows every row; deactivate; the VAT change is a pending request', async ({ page }) => {
  await page.goto(`/settings/tax?${ACC}`);
  await expect(page.getByRole('heading', { level: 1, name: 'ภาษี' })).toBeVisible();
  await expect(page.getByText('[SP-R]').first()).toBeVisible(); // the source of the read-only VAT status
  await shot(page, 'st3-tax-desktop');
  const row = page.getByRole('row').filter({ hasText: 'ค่าบริการ' }).filter({ hasText: 'SVC' }).first();
  await expect(row).toContainText('3%');
  await page.getByRole('button', { name: 'เปลี่ยนอัตรา ค่าบริการ', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: /เปลี่ยนอัตรา ค่าบริการ/ });
  await dialog.getByLabel('อัตราใหม่ (%)').fill('abc');
  await dialog.getByRole('button', { name: 'บันทึก' }).click();
  await expect(dialog.getByText('ใส่อัตราเป็นตัวเลขระหว่าง 0 ถึง 100')).toBeVisible();
  await dialog.getByLabel('อัตราใหม่ (%)').fill('5');
  await dialog.getByLabel('มีผลตั้งแต่วันที่').fill('2019-01-01');
  await dialog.getByRole('button', { name: 'บันทึก' }).click();
  await expect(dialog.getByText('วันที่มีผลก่อนอัตราแรกของประเภทนี้')).toBeVisible(); // R3-m2: a date before the first row is refused, with its own message
  await dialog.getByLabel('มีผลตั้งแต่วันที่').fill('2026-10-14');
  await shot(page, 'st3-tax-rate-form-desktop');
  await dialog.getByRole('button', { name: 'บันทึก' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(row).toContainText('5%');
  await page.getByRole('button', { name: 'ประวัติอัตรา ค่าบริการ', exact: true }).click();
  const hist = page.getByRole('table', { name: 'ประวัติอัตรา ค่าบริการ' });
  await expect(hist.getByRole('row')).toHaveCount(3); // header + the 2020 row + the new row: nothing was edited
  await expect(hist).toContainText('2020-01-01');
  await expect(hist).toContainText('3%');
  await shot(page, 'st3-tax-history-desktop');
  const types = await api<{ whtTypes: { code: string; rows: unknown[] }[] }>(page, '/settings/tax');
  expect(types.whtTypes.find((t) => t.code === 'SVC')?.rows).toHaveLength(2);

  await page.getByRole('button', { name: 'ปิดใช้งาน ค่าบริการ', exact: true }).click();
  await expect(page.getByRole('button', { name: 'เปิดใช้งาน ค่าบริการ', exact: true })).toBeVisible();
  const offered = await api<{ code: string }[]>(page, '/wht-types'); // the editors' list: a deactivated type is not offered
  expect(offered.some((w) => w.code === 'SVC')).toBe(false);

  await page.getByLabel('ขอยกเลิกการจดทะเบียน VAT ตั้งแต่วันที่').fill('2027-01-01');
  await page.getByRole('button', { name: 'ขอยกเลิกการจดทะเบียน VAT' }).click();
  await expect(page.getByText('ขอยกเลิกการจดทะเบียน VAT ตั้งแต่วันที่ 2027-01-01')).toBeVisible();
  await expect(page.getByText('รอดำเนินการ')).toBeVisible();
  await expect(page.getByText('จดทะเบียนภาษีมูลค่าเพิ่ม', { exact: true })).toBeVisible(); // the status itself never flips
  await axeClean(page);
});

test('numbering: the preview comes from the server; a monthly format without {MM} is refused; an in-use series says from which period it applies', async ({ page }) => {
  await page.goto(`/settings/numbering?${ADMIN}`);
  await expect(page.getByRole('heading', { level: 1, name: 'เลขที่เอกสาร' })).toBeVisible();
  const qt = page.getByRole('row').filter({ hasText: '(QT)' });
  await expect(qt).toContainText('{PREFIX}-{YYYY}{MM}-{####}');
  await expect(qt).toContainText(/QT-202610-\d{4}/);
  await shot(page, 'st3-numbering-desktop');
  await page.getByRole('button', { name: /^แก้ไขรูปแบบเลขที่ ใบเสนอราคา/ }).click();
  const dialog = page.getByRole('dialog', { name: /รูปแบบเลขที่ ใบเสนอราคา/ });
  await dialog.getByLabel('รูปแบบ', { exact: true }).fill('{PREFIX}-{YYYY}-{####}');
  await expect(dialog.getByTestId('number-preview').getByRole('alert')).toContainText('เลขรายเดือนต้องมี'); // numbering.missing_token, from the server
  await dialog.getByRole('button', { name: 'บันทึก' }).click();
  await expect(dialog.getByRole('alert').first()).toContainText('เลขรายเดือนต้องมี');
  await dialog.getByLabel('รูปแบบ', { exact: true }).fill('{PREFIX}/{YY}{MM}/{####}');
  await expect(dialog.getByTestId('number-preview-value')).toHaveText('QT/2611/0001'); // 2026-10 has QT numbers: the new format starts next period
  await shot(page, 'st3-numbering-form-desktop');
  await dialog.getByRole('button', { name: 'บันทึก' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId('numbering-notice')).toContainText('มีผลตั้งแต่งวด 2026-11');
  await expect(qt).toContainText('{PREFIX}/{YY}{MM}/{####}');
  await expect(qt).toContainText(/QT-202610-\d{4}/); // the current period keeps its stored format
  await shot(page, 'st3-numbering-saved-desktop');
  await axeClean(page);
});

test('approvals: a rule, the company-wide self-approval switch and the settlement tolerance are saved, audited and versioned', async ({ page }) => {
  await page.goto(`/settings/approvals?${ADMIN}`);
  await expect(page.getByRole('heading', { level: 1, name: 'การอนุมัติ' })).toBeVisible();
  await shot(page, 'st3-approvals-desktop');
  const min = page.getByLabel('วงเงินของ ใบสำคัญจ่าย');
  await expect(min).toHaveValue('50000.00');
  await min.fill('80000.00');
  await page.getByRole('button', { name: 'บันทึก ใบสำคัญจ่าย' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'บันทึกแล้ว' })).toBeVisible();
  await min.fill('-5');
  await page.getByRole('button', { name: 'บันทึก ใบสำคัญจ่าย' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'จำนวนเงิน' })).toBeVisible();
  let view = await api<{ items: { docType: string; minAmount?: string }[]; selfApproval: boolean }>(page, '/settings/approvals');
  expect(view.items.find((r) => r.docType === 'PV')?.minAmount).toBe('80000.00');

  await page.getByLabel('ผู้จัดทำอนุมัติเอกสารของตัวเองได้').uncheck();
  await page.getByRole('button', { name: 'บันทึก' }).nth(2).click();
  await expect.poll(async () => (await api<{ selfApproval: boolean }>(page, '/settings/approvals')).selfApproval).toBe(false);

  await page.getByLabel('ตัดส่วนต่างเล็กน้อย (บาท)').fill('20.00');
  await page.getByRole('button', { name: 'บันทึก' }).last().click();
  await expect.poll(async () => (await api<{ tolerance: { smallWriteOff: string } }>(page, '/settings/approvals')).tolerance.smallWriteOff).toBe('20.00');
  view = await api(page, '/settings/approvals');
  expect(view.selfApproval).toBe(false);
  await shot(page, 'st3-approvals-saved-desktop');
  await axeClean(page);
});

test('mobile 390: the three pages fit the width and the forms are usable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const [path, q, name, heading] of [['/settings/tax', ACC, 'tax', 'ภาษี'], ['/settings/numbering', ADMIN, 'numbering', 'เลขที่เอกสาร'], ['/settings/approvals', ADMIN, 'approvals', 'การอนุมัติ']] as const) {
    await page.goto(`${path}?${q}`);
    await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
    await shot(page, `st3-${name}-mobile`);
    expect(await noSideScroll(page), path).toBe(true);
  }
  await page.goto(`/settings/numbering?${ADMIN}`);
  await page.getByRole('button', { name: /^แก้ไขรูปแบบเลขที่ ใบเสนอราคา/ }).click();
  await expect(page.getByTestId('number-preview-value')).toBeVisible();
  expect(await noSideScroll(page)).toBe(true);
  await shot(page, 'st3-numbering-form-mobile');
  await axeClean(page);
});
