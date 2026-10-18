import { expect, test, type Page } from '@playwright/test';
import { axeClean } from './helpers/axe';
import { screenContract } from './helpers/screen-contract';

const AU = '/reports/audit';
const shot = async (page: Page, name: string) => { if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/${name}.png`, fullPage: true }); };
const api = <T,>(page: Page, path: string, init?: RequestInit) => page.evaluate(async ([p, i]) => { const r = await fetch(`/bff/v1${p}`, i as RequestInit); return { status: r.status, json: await r.json().catch(() => undefined) }; }, [path, init] as const) as Promise<{ status: number; json: T }>;
type Model = { rows: { level: number; kind: string; cells: Record<string, string> }[]; columns: { key: string }[] };

// audit.read is the accountant's and the owner's: the operator is forbidden on every tab
const gate = { company: 'both' as const, states: ['empty', 'loading', 'error', 'forbidden'] as ('empty' | 'loading' | 'error' | 'forbidden')[], forbiddenRole: 'operator' as const };
screenContract({ name: 'number check', path: `${AU}?tab=gaps`, heading: 'ตรวจสอบ', ...gate });
screenContract({ name: 'audit log', path: `${AU}?tab=log`, heading: 'ตรวจสอบ', ...gate });
screenContract({ name: 'reopen history', path: `${AU}?tab=reopen`, heading: 'ตรวจสอบ', ...gate });

test.afterEach(async ({ page }) => { await axeClean(page); });

test('number check: every series is listed as checked, the seed has no problem; "only problems" is empty', async ({ page }) => {
  await page.goto(`${AU}?tab=gaps&year=`);
  const table = page.getByRole('table', { name: 'ตรวจเลขที่เอกสาร (เลขขาด / เลขซ้ำ)' });
  await expect(table).toBeVisible();
  await expect(table.getByRole('cell', { name: 'ครบ', exact: true }).first()).toBeVisible();
  await expect(table.getByText('มีปัญหา')).toHaveCount(0);
  await expect(table.getByText('ถูกแทนที่').first()).toBeVisible(); // a replaced invoice keeps its number and says who replaced it: never a gap
  await shot(page, 'audit-gaps-desktop');
  await page.getByLabel('แสดงเฉพาะที่มีปัญหา').check();
  await expect(page.getByText('ไม่มีรายการในช่วงที่เลือก')).toBeVisible();
  const m = await api<Model>(page, '/reports/number-gaps?onlyProblems=true');
  expect(m.status).toBe(200); expect(m.json.rows).toHaveLength(0);
});

test('number check: a corrupted series (a document deleted from it) is found and named', async ({ page }) => {
  await page.goto(`${AU}?tab=gaps&year=`);
  await expect(page.getByRole('table', { name: 'ตรวจเลขที่เอกสาร (เลขขาด / เลขซ้ำ)' })).toBeVisible();
  const warm = await api<unknown>(page, '/periods/2026-06/reopen', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'เตรียมข้อมูล' }) }); // the first write saves the mock state to storage, where the test can corrupt it
  expect(warm.status).toBe(200);
  const gone = await page.evaluate(() => {
    const key = Object.keys(localStorage).find((k) => k.startsWith('teas2.mock.state'))!;
    const st = JSON.parse(localStorage.getItem(key)!);
    const d = st.docs.find((x: { companyId: string; number?: string }) => x.companyId === 'co-vat' && x.number === 'TI-202607-0002');
    st.docs.splice(st.docs.indexOf(d), 1);
    localStorage.setItem(key, JSON.stringify(st));
    return d.number as string;
  });
  await page.goto(`${AU}?tab=gaps&year=2026&month=7&type=TI`);
  const table = page.getByRole('table', { name: 'ตรวจเลขที่เอกสาร (เลขขาด / เลขซ้ำ)' });
  await expect(table.getByRole('cell', { name: 'มีปัญหา' })).toBeVisible();
  await expect(table.getByRole('row').filter({ hasText: gone })).toContainText('เลขขาด');
  await shot(page, 'audit-gaps-corrupt-desktop');
});

test('audit log: newest first with who / what / where from; an agent shows as "agent ของ"; the changed fields are a table; CSV', async ({ page }) => {
  await page.goto(`${AU}?tab=log`);
  const table = page.getByRole('table', { name: 'บันทึกการใช้งาน' });
  await expect(table).toBeVisible();
  for (const h of ['เวลา', 'ผู้ทำ', 'คำสั่ง', 'เป้าหมาย', 'ผล', 'ช่องทาง', 'IP', 'Trace', 'ฟิลด์ที่เปลี่ยน', 'ก่อน', 'หลัง']) await expect(table.getByRole('columnheader', { name: h, exact: true })).toBeVisible();
  await expect(table.getByText('posting.rule.update').first()).toBeVisible();
  await expect(table.getByText('127.0.0.1').first()).toBeVisible();
  await shot(page, 'audit-log-desktop');
  const m = await api<Model>(page, '/reports/audit-log');
  const ats = m.json.rows.filter((r) => r.level === 0).map((r) => r.cells.at);
  expect(ats).toEqual([...ats].sort().reverse());
  expect(m.json.rows.some((r) => r.level === 1 && r.cells.field === 'accountCode' && r.cells.before && r.cells.after)).toBe(true);
  await page.getByLabel('ผู้ทำ (user / agent / ชื่อ)').fill('agent');
  await expect(page).toHaveURL(/actor=agent/);
  await expect(table.getByText('agent ของ สมศรี บัญชีดี').first()).toBeVisible();
  await expect(table.getByText('mcp').first()).toBeVisible();
  await expect(table.getByRole('row').filter({ hasText: 'posting.rule.update' })).toHaveCount(0);
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'ส่งออก CSV' }).click()]);
  expect(download.suggestedFilename()).toBe('audit-log.csv');
});

test('audit log: a document target opens the document; the operator is refused on the API for all three; the other company\'s entries never appear', async ({ page }) => {
  await page.goto(`${AU}?tab=log&command=doc.issue&target=ti-`);
  const link = page.getByRole('table', { name: 'บันทึกการใช้งาน' }).getByRole('link', { name: /^ti-/ }).first();
  await expect(link).toBeVisible();
  await link.click();
  await expect(page).toHaveURL(/\/sales\/.*ti-/);
  await page.goto('/reports/audit?tab=log');
  await expect(page.getByRole('table', { name: 'บันทึกการใช้งาน' })).toBeVisible();
  const vat = (await api<Model>(page, '/reports/audit-log')).json.rows.filter((r) => r.level === 0).map((r) => r.cells.id);
  await page.goto('/reports/audit?tab=log&company=nonvat');
  await expect(page.getByRole('table', { name: 'บันทึกการใช้งาน' })).toBeVisible();
  const nv = (await api<Model>(page, '/reports/audit-log')).json.rows.filter((r) => r.level === 0).map((r) => r.cells.id);
  expect(vat.length).toBeGreaterThan(100); expect(nv.length).toBeGreaterThan(10);
  expect(vat.filter((i) => nv.includes(i))).toEqual([]);
  await page.goto('/reports/audit?tab=log&role=operator');
  await expect(page.locator('[data-screen-state="forbidden"]').first()).toBeVisible();
  for (const k of ['number-gaps', 'audit-log', 'reopen-history']) expect((await api<Model>(page, `/reports/${k}`)).status, k).toBe(403);
});

test('reopen history: empty until a month is reopened; then the reopen is listed with its reason and who', async ({ page }) => {
  await page.goto(`${AU}?tab=reopen`);
  await expect(page.getByText('ไม่มีรายการในช่วงที่เลือก')).toBeVisible();
  await shot(page, 'audit-reopen-empty-desktop');
  const r = await api<unknown>(page, '/periods/2026-06/reopen', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'พบรายการตกหล่น' }) });
  expect(r.status).toBe(200);
  await page.goto(`${AU}?tab=reopen`);
  const table = page.getByRole('table', { name: 'ประวัติการเปิดงวด' });
  await expect(table).toBeVisible();
  await expect(table).toContainText('พบรายการตกหล่น');
  await expect(table).toContainText('2026-06');
  await expect(table).toContainText('สมศรี บัญชีดี');
  await shot(page, 'audit-reopen-desktop');
});

test('r2-m2: the party picker shows the name of an id in the URL even when the list does not hold it', async ({ page }) => {
  await page.route('**/bff/v1/parties*', (route) => route.fulfill({ json: { items: [] } })); // the list (first 200) has nobody
  await page.goto('/reports/receivables-payables?tab=cs&party=pc-10&from=2026-01-01&to=2026-10-14');
  await expect(page.getByRole('combobox', { name: /ลูกค้า/ })).not.toHaveValue('pc-10');
  await expect(page.getByRole('combobox', { name: /ลูกค้า/ })).toHaveValue(/\S/);
});

test('390 px: each tab fits the page width (the table scrolls inside itself, the page does not)', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const [tab, name] of [['gaps', 'ตรวจเลขที่เอกสาร (เลขขาด / เลขซ้ำ)'], ['log', 'บันทึกการใช้งาน'], ['reopen', 'ประวัติการเปิดงวด']] as const) {
    await page.goto(`${AU}?tab=${tab}${tab === 'gaps' ? '&year=' : ''}`);
    if (tab !== 'reopen') await expect(page.getByRole('table', { name })).toBeVisible(); else await expect(page.getByText('ไม่มีรายการในช่วงที่เลือก')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/audit-${tab}-390.png` });
  }
});
