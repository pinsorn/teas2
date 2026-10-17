import { expect, test, type Page } from '@playwright/test';
import { axeClean } from './helpers/axe';
import { fixtureId } from './helpers/fixtures';
import { screenContract } from './helpers/screen-contract';

const BASE = '/accounting/schedules';
const STATES = ['empty', 'loading', 'error', 'forbidden'] as const;
const shot = async (page: Page, name: string) => { if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/${name}.png`, fullPage: true }); };

// schedules are the accountant's (ledger.read to read, ledger.schedule.manage to act): the operator is forbidden on every screen
screenContract({ name: 'schedules list', path: BASE, heading: 'รายการซ้ำและตัดจ่าย', company: 'both', states: [...STATES], forbiddenRole: 'operator' });
screenContract({ name: 'schedule (amortisation)', path: async (p) => `${BASE}/${await fixtureId(p, 'schedAmortisation')}`, heading: 'เบี้ยประกันอัคคีภัยอาคาร', company: 'vat', otherCompany: 'not-found', states: ['loading', 'error', 'forbidden'], forbiddenRole: 'operator' });
screenContract({ name: 'schedule (recurring TI)', path: async (p) => `${BASE}/${await fixtureId(p, 'schedRecurringTi')}`, heading: 'ดูแลเว็บไซต์รายเดือน', company: 'vat', otherCompany: 'not-found', states: ['loading', 'error', 'forbidden'] });
screenContract({ name: 'schedule (recurring IV, non-VAT)', path: async (p) => `${BASE}/${await fixtureId(p, 'nschedRecurring')}`, heading: 'ค่าบริการรายเดือน', company: 'nonvat', otherCompany: 'not-found', states: ['loading', 'error', 'forbidden'] });

test.beforeEach(async ({ page }) => { await page.goto('/'); await page.evaluate(() => localStorage.clear()); await page.reload(); });

const api = <T,>(page: Page, path: string) => page.evaluate(async (p) => (await fetch(`/bff/v1${p}`)).json(), path) as Promise<T>;
const send = (page: Page, method: string, path: string, body: unknown) => page.evaluate(async ([m, p, b]) => {
  const r = await fetch(`/bff/v1${p as string}`, { method: m as string, headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
  return { status: r.status, json: await r.json().catch(() => undefined) } as { status: number; json: Record<string, unknown> & { code?: string; title?: string; id?: string; version?: number } };
}, [method, path, body] as const);
const cancelDoc = async (page: Page, type: string, id: string) => send(page, 'POST', `/docs/${type}/${id}/cancel`, { version: (await api<{ version: number }>(page, `/docs/${type}/${id}`)).version, reasonCode: 'OTHER', reasonText: 'x' });
type Ledger = { entries: { kind: string; date: string; lines: { accountCode: string; debit: string; credit: string }[] }[] };

test('amortisation: 3 months done, October is not over so it is refused, reversing the last run lets that month run again', async ({ page }) => {
  await page.goto('/'); const id = await fixtureId(page, 'schedAmortisation');
  await page.goto(`${BASE}/${id}`);
  await expect(page.getByRole('heading', { level: 1, name: 'เบี้ยประกันอัคคีภัยอาคาร' })).toBeVisible();
  await expect(page.getByTestId('schedule-state')).toHaveText('ใช้งานอยู่');
  await expect(page.getByTestId('remaining')).toHaveText('9,000.00'); // 12,000.00 - 3 x 1,000.00 still on 1150
  const plan = page.getByRole('region', { name: 'ตารางตัดจ่าย' });
  await expect(plan.getByRole('row')).toHaveCount(13); // header + 12 months
  await expect(plan.getByTestId('plan-2026-09')).toContainText('ตัดแล้ว');
  await expect(plan.getByTestId('plan-2026-10')).toContainText('งวดถัดไป');
  await expect(plan.getByTestId('plan-2026-11')).toContainText('รอตัด');
  await shot(page, 'sched-amort');
  await axeClean(page);
  // October is not over (today is mid October): nothing is posted ahead - refused in place, nothing written
  await page.getByRole('button', { name: 'รันตอนนี้' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'ยังไม่ถึงกำหนด' })).toBeVisible();
  await expect(page.getByTestId('remaining')).toHaveText('9,000.00');
  await shot(page, 'sched-amort-not-due');
  // the last run's voucher (September) cannot be edited / cancelled directly: its lock leads to กลับรายการ
  const last = (await api<{ runs: { resultDocId: string; month: string; reversed?: boolean }[] }>(page, `/records/schedule/${id}`)).runs.filter((r) => !r.reversed).at(-1)!;
  expect(last.month).toBe('2026-09');
  const rv = await cancelDoc(page, 'JV', last.resultDocId);
  expect(rv.status).toBe(409);
  expect(rv.json.title).toContain('กลับรายการ');
  // reverse it: the run is marked reversed and September can run again
  const rev = await send(page, 'POST', `/docs/JV/${last.resultDocId}/reverse`, {});
  expect(rev.status).toBe(201);
  await page.reload();
  await expect(page.getByTestId('remaining')).toHaveText('10,000.00');
  await expect(plan.getByTestId('plan-2026-09')).toContainText('งวดถัดไป');
  await expect(page.getByRole('cell', { name: 'กลับรายการแล้ว' })).toBeVisible();
  await page.getByRole('button', { name: 'รันตอนนี้' }).click();
  await expect(page.getByTestId('run-result')).toContainText('1,000.00');
  await expect(page.getByTestId('remaining')).toHaveText('9,000.00');
  // the new run: [expense 5120 Dr, prepaid 1150 Cr], dated the last day of the plan month
  const run = (await api<{ runs: { resultDocId: string; month: string; reversed?: boolean }[] }>(page, `/records/schedule/${id}`)).runs.filter((r) => !r.reversed).at(-1)!;
  expect(run.month).toBe('2026-09');
  const ledger = await api<Ledger>(page, `/docs/JV/${run.resultDocId}/ledger`);
  expect(ledger.entries[0].date).toBe('2026-09-30');
  expect(ledger.entries[0].lines.map((l) => [l.accountCode, l.debit, l.credit])).toEqual([['5120', '1000.00', '0.00'], ['1150', '0.00', '1000.00']]);
});

test('source lock: the insurance bill cannot be cancelled while its schedule is not stopped; its lock banner leads to the schedule; after the stop the runs still hold the bill', async ({ page }) => {
  await page.goto('/');
  await page.goto('/purchases/bills/pb-ins');
  await expect(page.getByTestId('doc-number')).toHaveText(/^PB-/);
  const lock = page.getByRole('status', { name: 'ล็อก' });
  await expect(lock).toContainText('ตารางตัดจ่าย "เบี้ยประกันอัคคีภัยอาคาร" ใช้รายการนี้อยู่ (ตัดจ่ายแล้ว 3 งวด)');
  await expect(page.getByRole('button', { name: 'ยกเลิกเอกสาร' })).toBeDisabled();
  const c = await cancelDoc(page, 'PB', 'pb-ins');
  expect(c.status).toBe(409);
  expect(c.json.code).toBe('schedule.source_locked');
  await shot(page, 'sched-source-lock');
  await lock.getByRole('button', { name: 'หยุดตารางตัดจ่าย เบี้ยประกันอัคคีภัยอาคาร' }).click();
  await expect(page).toHaveURL(/\/accounting\/schedules\/sch-amort$/);
  await page.getByRole('button', { name: 'หยุด', exact: true }).click();
  await page.getByRole('alertdialog').getByLabel('เหตุผล (ไม่บังคับ)').fill('เลิกกรมธรรม์');
  await expect(page.getByRole('alertdialog')).toContainText('9,000.00'); // what stays on the prepaid account
  await page.getByRole('alertdialog').getByRole('button', { name: 'หยุด', exact: true }).click();
  await expect(page.getByTestId('schedule-state')).toHaveText('หยุดแล้ว');
  await expect(page.getByRole('button', { name: 'รันตอนนี้' })).toBeDisabled();
  await expect(page.getByTestId('remaining')).toHaveText('9,000.00'); // nothing is posted by a stop
  // the runs are still live and the bill backs them (stopping does not undo them): a cancel is refused until they are reversed
  const c2 = await cancelDoc(page, 'PB', 'pb-ins');
  expect(c2.json.code).toBe('schedule.source_consumed');
});

test('recurring: run now makes a DRAFT dated the next run (never issued), the run date advances, the draft is in the TI list', async ({ page }) => {
  await page.goto('/'); const id = await fixtureId(page, 'schedRecurringTi');
  await page.goto(`${BASE}/${id}`);
  await expect(page.getByTestId('next-run')).toContainText('1 พ.ย. 2569');
  await expect(page.getByRole('region', { name: 'แม่แบบ' }).last()).toContainText('ดูแลเว็บไซต์รายเดือน');
  await shot(page, 'sched-recurring');
  await page.getByRole('button', { name: 'รันตอนนี้' }).click();
  const result = page.getByTestId('run-result');
  await expect(result).toContainText('สร้างฉบับร่างลงวันที่');
  await expect(page.getByTestId('next-run')).toContainText('1 ธ.ค. 2569');
  const href = await result.getByRole('link').getAttribute('href');
  expect(href).toMatch(/^\/sales\/tax-invoices\/[^/]+$/);
  const draft = await api<{ status: string; number?: string; header: { documentDate: string; partyId: string } }>(page, `/docs/TI/${href!.split('/').pop()}`);
  expect(draft).toMatchObject({ status: 'draft', header: { documentDate: '2026-11-01', partyId: 'pc-04' } });
  expect(draft.number).toBeUndefined(); // a recurring run never issues
  await page.goto('/sales/tax-invoices?view=draft');
  await expect(page.locator(`a[href="${href}"]`).first()).toBeVisible();
  await page.goto(href!);
  await expect(page.getByRole('link', { name: 'บันทึกและออก…' })).toBeVisible(); // a draft: the only way on is to check and issue it
});

test('make a document recurring and amortise a prepaid bill from the document page', async ({ page }) => {
  await page.goto('/');
  // a recurring schedule from an issued tax invoice
  const ti = await fixtureId(page, 'tiIssuedUnpaid');
  await page.goto(`/sales/tax-invoices/${ti}`);
  await page.getByRole('button', { name: 'ตั้งเป็นรายการซ้ำ' }).click();
  const dlg = page.getByRole('dialog');
  await shot(page, 'sched-dialog-recurring');
  await dlg.getByLabel('ความถี่').selectOption('quarterly');
  await dlg.getByLabel('หยุดหลังรัน (ครั้ง)').fill('2');
  await dlg.getByRole('button', { name: 'ตั้งรายการซ้ำ' }).click();
  await expect(page).toHaveURL(/\/accounting\/schedules\/sch-\d+$/);
  await expect(page.getByTestId('schedule-state')).toHaveText('ใช้งานอยู่');
  await expect(page.getByText('2 ครั้ง')).toBeVisible();
  // a prepaid bill: a PB line on the prepaid category, then "ตั้งตัดจ่าย"
  const h = { 'content-type': 'application/json' };
  const pbId = await page.evaluate(async (hh) => {
    const line = { id: 'e2e-l1', description: 'ค่าเช่าซอฟต์แวร์รายปี', qty: '1', unit: 'ปี', unitPrice: '6000.00', taxCode: 'EX', expenseCategory: 'prepaid' };
    const d = await (await fetch('/bff/v1/docs/PB', { method: 'POST', headers: hh, body: JSON.stringify({ header: { documentDate: '2026-10-10', partyId: 'pv-02', vendorDocNumber: 'E2E-1', vendorDocDate: '2026-10-10' }, lines: [line] }) })).json();
    return ((await (await fetch(`/bff/v1/docs/PB/${d.id}/issue`, { method: 'POST', headers: hh, body: JSON.stringify({ version: d.version }) })).json()) as { id: string }).id;
  }, h);
  await page.goto(`/purchases/bills/${pbId}`);
  await page.getByRole('button', { name: 'ตั้งตัดจ่าย' }).click();
  const d2 = page.getByRole('dialog');
  await expect(d2.getByLabel('ยอดที่ตัดจ่าย')).toHaveValue('6000.00');
  await shot(page, 'sched-dialog-amortise');
  await d2.getByLabel('จำนวนงวด (เดือน)').fill('4');
  await d2.getByLabel('บัญชีค่าใช้จ่าย').selectOption('5120');
  await d2.getByRole('button', { name: 'ตั้งตารางตัดจ่าย' }).click();
  await expect(page).toHaveURL(/\/accounting\/schedules\/sch-\d+$/);
  const plan = page.getByRole('region', { name: 'ตารางตัดจ่าย' });
  await expect(plan.getByRole('row')).toHaveCount(5);
  await expect(plan.getByTestId('plan-2026-10')).toContainText('1,500.00');
  // a second schedule on the same line is refused with the cause
  await page.goto(`/purchases/bills/${pbId}`);
  await page.getByRole('button', { name: 'ตั้งตัดจ่าย' }).click();
  await page.getByRole('dialog').getByLabel('บัญชีค่าใช้จ่าย').selectOption('5120');
  await page.getByRole('dialog').getByRole('button', { name: 'ตั้งตารางตัดจ่าย' }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('มีตารางตัดจ่าย');
});

test('the record route refuses a second schedule on a taken source line and a malformed body', async ({ page }) => {
  await page.goto('/'); await fixtureId(page, 'schedAmortisation'); // the mock worker is up
  const r = await send(page, 'POST', '/records/schedule', { kind: 'amortisation', docId: 'pb-ins', lineId: 'pb-ins-l1', name: 'x', total: '100.00', months: 2, startMonth: '2026-10', expenseAccount: '5120' });
  expect(r.json?.code, JSON.stringify(r)).toBe('schedule.source_taken');
  const bad = await send(page, 'POST', '/records/schedule', { kind: 'amortisation', docId: 'pb-ins', name: 'x', total: 'abc', months: 0, startMonth: 'x' });
  expect(bad.status).toBe(422);
});

test('phone width: the schedule page does not scroll sideways', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/'); const id = await fixtureId(page, 'schedAmortisation');
  await page.goto(`${BASE}/${id}`);
  await expect(page.getByRole('heading', { level: 1, name: 'เบี้ยประกันอัคคีภัยอาคาร' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await shot(page, 'sched-amort-mobile');
  await page.goto(BASE);
  await expect(page.getByRole('heading', { level: 1, name: 'รายการซ้ำและตัดจ่าย' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await shot(page, 'sched-list-mobile');
});

test('AC7b: the template opens in the document editor, an edited line is saved (old template kept in history), and the next run makes a draft carrying them', async ({ page }) => {
  await page.goto('/'); const id = await fixtureId(page, 'schedRecurringTi');
  await page.goto(`${BASE}/${id}`);
  await page.getByRole('button', { name: 'แก้ไขแม่แบบ' }).click();
  await expect(page).toHaveURL(`${BASE}/${id}/template`);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('แก้ไขแม่แบบ');
  await expect(page.getByRole('combobox', { name: 'ลูกค้า' })).not.toHaveValue(''); // prefilled from the frozen template
  await expect(page.getByLabel('วันที่เอกสาร')).toHaveCount(0); // no date, no number, no issue
  await expect(page.getByRole('button', { name: /^ออก/ })).toHaveCount(0);
  const price = page.getByRole('textbox', { name: /^ราคาต่อหน่วย/ }).first();
  await expect(price).toHaveValue('8000.00');
  await shot(page, 'sched-template-editor');
  await price.fill('9500'); await price.blur();
  const save = page.getByRole('button', { name: 'บันทึกแม่แบบ' });
  await expect(page.getByRole('region', { name: 'ยังขาดอะไร' })).toContainText('ครบแล้ว', { timeout: 15000 });
  await expect(save).toBeEnabled();
  await save.click();
  await expect(page).toHaveURL(`${BASE}/${id}`);
  await expect(page.getByRole('region', { name: 'แม่แบบ' }).last()).toContainText('9,500.00');
  const row = await api<{ template: { lines: { unitPrice: string }[] }; templateHistory: { by: { name: string }; template: { lines: { unitPrice: string }[] } }[] }>(page, `/records/schedule/${id}`);
  expect(row.template.lines[0].unitPrice).toBe('9500.00');
  expect(row.templateHistory).toHaveLength(1);
  expect(row.templateHistory[0].template.lines[0].unitPrice).toBe('8000.00'); // the old template is kept, with who / when
  await page.getByRole('button', { name: 'รันตอนนี้' }).click();
  const href = await page.getByTestId('run-result').getByRole('link').getAttribute('href');
  const draft = await api<{ status: string; lines: { unitPrice: string }[] }>(page, `/docs/TI/${href!.split('/').pop()}`);
  expect(draft).toMatchObject({ status: 'draft', lines: [{ unitPrice: '9500.00' }] }); // the draft carries the edited line
});

test('AC7b: the template editor on a phone does not scroll sideways, and an amortisation has no template editor', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/'); const id = await fixtureId(page, 'schedRecurringTi');
  await page.goto(`${BASE}/${id}/template`);
  await expect(page.getByRole('button', { name: 'บันทึกแม่แบบ' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'ยังขาดอะไร' })).toContainText('ครบแล้ว', { timeout: 15000 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await shot(page, 'sched-template-editor-mobile');
  await page.goto(`${BASE}/${await fixtureId(page, 'schedAmortisation')}`);
  await expect(page.getByRole('button', { name: 'แก้ไขแม่แบบ' })).toHaveCount(0);
});
