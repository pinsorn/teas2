import { expect, test, type Page } from '@playwright/test';
import { axeClean } from './helpers/axe';
import { fixtureId } from './helpers/fixtures';

const api = <T,>(page: Page, path: string) => page.evaluate(async (p) => (await fetch(`/bff/v1${p}`)).json(), path) as Promise<T>;
const pdf = (bytes = 64) => ({ name: 'po.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(bytes, 'a') });
const pickCustomer = async (page: Page, q: string) => {
  await page.getByRole('combobox', { name: 'ลูกค้า' }).fill(q);
  await page.getByRole('option').first().waitFor();
  await page.keyboard.press('Enter');
};

test('a new quotation starts with the default note; a file attached while creating is kept on issue, and removing it later is confirmed and recorded', async ({ page }, info) => {
  await page.goto('/'); await fixtureId(page, 'qtIssued');
  await page.goto('/sales/quotations/new');
  await expect(page.getByRole('textbox', { name: 'หมายเหตุ' })).toHaveValue(/ใบเสนอราคานี้ยืนราคา/);
  await pickCustomer(page, 'นาวา');
  await expect(page.getByRole('region', { name: 'ยังขาดอะไร' })).toHaveText(/ครบแล้ว/);
  await page.getByLabel('เลือกไฟล์').setInputFiles(pdf());
  await expect(page.getByRole('link', { name: 'po.pdf' })).toBeVisible(); // the draft was saved for it
  await axeClean(page);
  await page.screenshot({ path: info.outputPath('desktop-editor-attachments.png'), fullPage: true });
  await page.keyboard.press('Control+Enter');
  await page.getByRole('alertdialog').getByRole('button', { name: /^ออกใบเสนอราคา$/ }).click();
  await expect(page.getByTestId('doc-number')).toHaveText(/^QT-\d{6}-\d{4}$/);
  const id = page.url().split('/').pop()!;
  await page.getByRole('tab', { name: 'ไฟล์แนบ' }).click();
  await expect(page.getByRole('link', { name: 'po.pdf' })).toBeVisible(); // kept on issue
  await page.getByRole('button', { name: 'ลบไฟล์ po.pdf' }).click();
  await expect(page.getByRole('alertdialog')).toContainText('บันทึกในประวัติ');
  await page.getByRole('alertdialog').getByRole('button', { name: 'ลบไฟล์' }).click();
  await expect(page.getByRole('link', { name: 'po.pdf' })).toHaveCount(0);
  await page.getByRole('tab', { name: 'กิจกรรม' }).click();
  await expect(page.getByText('ลบไฟล์แนบ')).toBeVisible();
  expect(await api<unknown[]>(page, `/docs/QT/${id}/attachments`)).toEqual([]);
});

test('attachment limits: over 1 MB and a wrong type are refused in place; reset removes the uploaded file and restores the seed files', async ({ page }) => {
  const stored = () => page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('teas2.mock.att.')).length);
  await page.goto('/'); const id = await fixtureId(page, 'tiDraft');
  const seeded = await stored(); // the seed carries its own files (the ex-pend receipt photo): count them, never assume none
  expect(seeded).toBeGreaterThan(0);
  await page.goto(`/sales/tax-invoices/${id}`);
  await page.getByRole('tab', { name: 'ไฟล์แนบ' }).click();
  await page.getByLabel('เลือกไฟล์').setInputFiles(pdf(1024 * 1024 + 1));
  await expect(page.getByRole('region', { name: 'ไฟล์แนบ' }).getByRole('alert')).toContainText('ไฟล์ใหญ่เกิน 1 MB');
  await page.getByLabel('เลือกไฟล์').setInputFiles({ name: 'x.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
  await expect(page.getByRole('region', { name: 'ไฟล์แนบ' }).getByRole('alert')).toContainText('PDF, PNG, JPEG');
  await page.getByLabel('เลือกไฟล์').setInputFiles(pdf());
  await expect(page.getByRole('link', { name: 'po.pdf' })).toBeVisible();
  expect(await stored()).toBe(seeded + 1);
  await page.getByRole('button', { name: 'โหมดตัวอย่าง' }).click();
  await page.getByRole('button', { name: 'รีเซ็ตข้อมูลตัวอย่าง' }).click();
  expect(await stored()).toBe(seeded); // reset clears every stored file, then the seed writes its own back: the upload is gone, the seed's photo is there
});

test('print: the first print is the original, the next asks and prints a copy; both are on the timeline', async ({ page }) => {
  await page.addInitScript(() => { window.print = () => undefined; });
  await page.goto('/'); const id = await fixtureId(page, 'tiIssuedUnpaid');
  await page.goto(`/sales/tax-invoices/${id}`);
  await page.getByRole('link', { name: 'พิมพ์' }).click();
  await expect(page).toHaveURL(new RegExp(`/print/TI/${id}$`));
  await expect(page.locator('[data-paper-ready="true"]')).toBeVisible();
  await expect(page.locator('.paper-pill').first()).toHaveText('ต้นฉบับ');
  await page.getByRole('button', { name: 'พิมพ์' }).click(); // logs the print, then window.print()
  await expect.poll(async () => (await api<{ printCount?: number }>(page, `/docs/TI/${id}`)).printCount).toBe(1);
  await page.goto(`/sales/tax-invoices/${id}`);
  await page.getByRole('button', { name: 'พิมพ์' }).click();
  const dlg = page.getByRole('alertdialog');
  await expect(dlg).toContainText("พิมพ์ซ้ำจะพิมพ์เป็น 'สำเนา'");
  await dlg.getByRole('button', { name: 'พิมพ์สำเนา' }).click();
  await expect(page).toHaveURL(new RegExp(`/print/TI/${id}\\?copy=1$`));
  await expect(page.locator('.paper-pill').first()).toHaveText('สำเนา');
  await expect(page.locator('[data-paper-ready="true"]')).toBeVisible();
  await page.getByRole('button', { name: 'พิมพ์' }).click();
  await expect.poll(async () => (await api<{ printCount?: number }>(page, `/docs/TI/${id}`)).printCount).toBe(2);
  await page.goto(`/sales/tax-invoices/${id}`);
  await page.getByRole('tab', { name: 'กิจกรรม' }).click();
  await expect(page.getByText('พิมพ์ต้นฉบับ')).toHaveCount(1);
  await expect(page.getByText('พิมพ์สำเนา')).toHaveCount(1);
});

test('agent: the list has the "สร้างโดย AI" view and chip, and an agent draft shows the banner on view and in the editor', async ({ page }) => {
  await page.goto('/'); const id = await fixtureId(page, 'tiAgentDraft');
  await page.goto('/sales/tax-invoices');
  await expect(page.getByRole('row').nth(1)).toBeVisible();
  const all = await page.getByRole('row').count();
  await page.getByRole('button', { name: 'สร้างโดยผู้ช่วย AI' }).click();
  await expect(page).toHaveURL(/agent=1/);
  await expect(page.getByText('สร้างโดย AI').first()).toBeVisible(); // the row chip
  await expect.poll(async () => page.getByRole('row').count()).toBeLessThan(all);
  await page.goto(`/sales/tax-invoices/${id}`);
  await expect(page.getByTestId('agent-banner')).toContainText('ร่างโดย ผู้ช่วยบัญชี (AI) ของ สมศรี บัญชีดี');
  await axeClean(page);
  await page.goto(`/sales/tax-invoices/${id}/edit`);
  await expect(page.getByTestId('agent-banner')).toContainText('ร่างโดย ผู้ช่วยบัญชี (AI)');
  const mine = await fixtureId(page, 'tiDraft');
  await page.goto(`/sales/tax-invoices/${mine}`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.getByTestId('agent-banner')).toHaveCount(0);
});

test.describe('mobile 390x844', () => {
  test.use({ viewport: { width: 390, height: 844 } });
  const noSideScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  test('attachments tab, agent banner and the editor panel fit the phone', async ({ page }, info) => {
    await page.goto('/'); const agent = await fixtureId(page, 'tiAgentDraft');
    await page.goto(`/sales/tax-invoices/${agent}`);
    await expect(page.getByTestId('agent-banner')).toBeVisible();
    await page.getByRole('tab', { name: 'ไฟล์แนบ' }).click();
    await page.getByLabel('เลือกไฟล์').setInputFiles(pdf());
    await expect(page.getByRole('link', { name: 'po.pdf' })).toBeVisible();
    expect(await noSideScroll(page)).toBe(true);
    await axeClean(page);
    await page.screenshot({ path: info.outputPath('view-attachments.png'), fullPage: true });
    await page.goto('/sales/quotations/new');
    await expect(page.getByRole('textbox', { name: 'หมายเหตุ' })).toHaveValue(/ใบเสนอราคานี้ยืนราคา/);
    await expect(page.getByLabel('เลือกไฟล์')).toBeVisible();
    expect(await noSideScroll(page)).toBe(true);
    await page.screenshot({ path: info.outputPath('editor-attachments.png'), fullPage: true });
  });
});
