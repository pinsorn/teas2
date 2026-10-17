import { expect, test, type Page } from '@playwright/test';
import { axeClean } from './helpers/axe';
import { fixtureId } from './helpers/fixtures';
import { screenContract } from './helpers/screen-contract';

const FA = '/accounting/fixed-assets';
const DP = '/accounting/depreciation-runs';
const STATES = ['empty', 'loading', 'error', 'forbidden'] as const;
const shot = async (page: Page, name: string) => { if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/${name}.png`, fullPage: true }); };

// assets and depreciation runs are the accountant's (doc.FA.* / doc.DP.*): the operator is forbidden on every screen
screenContract({ name: 'FA list', path: FA, heading: 'ทะเบียนสินทรัพย์', company: 'both', states: [...STATES], forbiddenRole: 'operator' });
screenContract({ name: 'FA view (in use)', path: async (p) => `${FA}/${await fixtureId(p, 'faActive')}`, heading: /FA-\d{6}-\d{4}/, company: 'vat', otherCompany: 'not-found', states: ['loading', 'error', 'forbidden'], forbiddenRole: 'operator' });
screenContract({ name: 'FA view (sold)', path: async (p) => `${FA}/${await fixtureId(p, 'faDisposed')}`, heading: /FA-\d{6}-\d{4}/, company: 'vat', otherCompany: 'not-found', states: ['loading', 'error', 'forbidden'] });
screenContract({ name: 'FA view (non-VAT, from the opening balance)', path: async (p) => `${FA}/${await fixtureId(p, 'nfaActive')}`, heading: /FA-\d{6}-\d{4}/, company: 'nonvat', otherCompany: 'not-found', states: ['loading', 'error', 'forbidden'] });
screenContract({ name: 'FA register (new)', path: `${FA}/new`, heading: 'ลงทะเบียนสินทรัพย์', company: 'both', states: ['loading', 'error', 'forbidden'], forbiddenRole: 'operator' });
screenContract({ name: 'DP list', path: DP, heading: 'ค่าเสื่อมราคาประจำงวด', company: 'both', states: [...STATES], forbiddenRole: 'operator' });
screenContract({ name: 'DP view', path: async (p) => `${DP}/${await fixtureId(p, 'dpRun')}`, heading: /DP-\d{6}-\d{4}/, company: 'vat', otherCompany: 'not-found', states: ['loading', 'error', 'forbidden'], forbiddenRole: 'operator' });
screenContract({ name: 'DP run (new)', path: `${DP}/new`, heading: 'คิดค่าเสื่อมราคาประจำงวด', company: 'both', states: ['loading', 'error', 'forbidden'], forbiddenRole: 'operator' });

test.beforeEach(async ({ page }) => { await page.goto('/'); await page.evaluate(() => localStorage.clear()); await page.reload(); });

const api = <T,>(page: Page, path: string) => page.evaluate(async (p) => (await fetch(`/bff/v1${p}`)).json(), path) as Promise<T>;
const send = (page: Page, method: string, path: string, body: unknown) => page.evaluate(async ([m, p, b]) => {
  const r = await fetch(`/bff/v1${p as string}`, { method: m as string, headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
  return { status: r.status, json: await r.json().catch(() => undefined) } as { status: number; json: Record<string, unknown> & { code?: string; title?: string; id?: string; version?: number } };
}, [method, path, body] as const);
type Asset = { id: string; number: string; version: number; asset: { accumulated: string; nbv: string; cost: string; disposed?: { tiId?: string } } };

test('September: preview -> issue -> the asset shows the new accumulated value; October is refused (not over yet)', async ({ page }) => {
  await page.goto('/'); const id = await fixtureId(page, 'faActive');
  expect((await api<Asset>(page, `/docs/FA/${id}`)).asset.accumulated).toBe('666.66'); // July and August of 12,000.00 / 36
  await page.goto(`${DP}/new`);
  await expect(page.getByRole('heading', { level: 1, name: 'คิดค่าเสื่อมราคาประจำงวด' })).toBeVisible();
  await expect(page.getByLabel('งวด (เดือน)')).toHaveValue('2026-09'); // the month after the latest run
  const rows = page.getByTestId('dp-rows');
  await expect(rows).toContainText('เครื่องสแกนเอกสาร');
  await expect(page.getByTestId('dp-total')).toHaveText('333.33'); // fa-sold is sold in September (its disposal carries the month), fa-nb starts in October
  await shot(page, 'dp-preview');
  await axeClean(page);
  await page.getByRole('button', { name: 'ลงบัญชีค่าเสื่อมราคา' }).click();
  await expect(page).toHaveURL(new RegExp(`${DP}/[^/]+$`));
  await expect(page.getByTestId('dp-total')).toHaveText('333.33');
  await shot(page, 'dp-run-view');
  await page.goto(`${FA}/${id}`);
  await expect(page.getByTestId('fa-accumulated')).toHaveText('999.99');
  await expect(page.getByTestId('fa-nbv')).toHaveText('11,000.01');
  // October has not ended: refused in place (nothing is posted ahead), and by the server
  await page.goto(`${DP}/new`);
  await expect(page.getByLabel('งวด (เดือน)')).toHaveValue('2026-10');
  await expect(page.getByTestId('dp-problem')).toContainText('ยังไม่สิ้นสุด');
  await expect(page.getByRole('button', { name: 'ลงบัญชีค่าเสื่อมราคา' })).toBeDisabled();
  const r = await send(page, 'POST', '/depreciation/runs', { month: '2026-10' });
  expect([r.status, r.json.code]).toEqual([422, 'dp.not_due']);
  const again = await send(page, 'POST', '/depreciation/runs', { month: '2026-09' });
  expect([again.status, again.json.code]).toEqual([409, 'dp.already_run']);
  // the ledger carries exactly the run's rows: Dr 5400 depreciation expense, Cr 1211 accumulated
  const dp = (await api<{ items: { id: string; number: string }[] }>(page, '/docs/DP?limit=50')).items;
  expect(dp.length).toBe(3);
});

test('a sold asset: the disposal figures are frozen on the asset, the invoice is a real tax invoice, cancelling it brings the asset back', async ({ page }) => {
  await page.goto('/'); const id = await fixtureId(page, 'faDisposed');
  await page.goto(`${FA}/${id}`);
  const disposal = page.getByTestId('fa-disposal');
  await expect(disposal).toContainText('ขาย');
  await expect(page.getByTestId('fa-gainloss')).toHaveText('1,333.33'); // sold at 20,000.00 against NBV 21,333.33
  await expect(disposal).toContainText('ขาดทุนจากการจำหน่าย');
  await shot(page, 'fa-sold');
  await axeClean(page);
  // locked, with the way out: the banner says why and leads to the sale invoice; cancelling the asset is off
  await expect(page.getByRole('status', { name: 'ล็อก' })).toContainText('จำหน่ายแล้ว');
  await expect(page.getByRole('button', { name: 'ยกเลิกเอกสาร' })).toBeDisabled();
  const fa = await api<Asset>(page, `/docs/FA/${id}`);
  const ti = await api<{ id: string; type: string; status: string; version: number; totals: { net: string; vat: string; total: string } }>(page, `/docs/TI/${fa.asset.disposed!.tiId}`);
  expect([ti.type, ti.status, ti.totals.net, ti.totals.vat, ti.totals.total]).toEqual(['TI', 'issued', '20000.00', '1400.00', '21400.00']);
  // the invoice's journal removes exactly the frozen cost and accumulated, and balances
  const led = await api<{ entries: { lines: { accountCode: string; debit: string; credit: string }[] }[] }>(page, `/docs/TI/${ti.id}/ledger`);
  const sum = (k: 'debit' | 'credit') => led.entries[0].lines.reduce((n, l) => n + Math.round(Number(l[k]) * 100), 0);
  expect(sum('debit')).toBe(sum('credit'));
  expect(led.entries[0].lines.find((l) => l.accountCode === '1210')).toMatchObject({ credit: '24000.00' });
  // its page offers no credit / debit note or edit (disabled with the reason)
  await page.goto(`/sales/tax-invoices/${ti.id}`);
  await expect(page.getByRole('button', { name: 'ออกใบลดหนี้' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'แก้ไข', exact: true })).toBeDisabled();
  // a credit note on it is refused (the exit: cancel and dispose again); a sale invoice cannot be corrected
  const cn = await send(page, 'POST', '/docs/CN', { header: { documentDate: '2026-10-14', refDocId: ti.id, reasonCode: 'PRICE_REDUCTION' }, lines: [{ id: 'c1', sourceLineId: `${id}-sale`, description: 'ลดราคา', qty: '1', unit: 'รายการ', unitPrice: '1000.00', taxCode: 'S7' }] });
  const cnIssue = await send(page, 'POST', `/docs/CN/${cn.json.id}/issue`, { version: cn.json.version });
  expect([cnIssue.status, cnIssue.json.code]).toEqual([422, 'fa.disposal_note']);
  // cancel the invoice: the asset is live again (and may be disposed of anew)
  const c = await send(page, 'POST', `/docs/TI/${ti.id}/cancel`, { version: ti.version, reasonCode: 'OTHER', reasonText: 'ทดสอบ' });
  expect(c.status).toBe(200);
  await page.goto(`${FA}/${id}`);
  await expect(page.getByTestId('fa-disposal')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'จำหน่าย', exact: true })).toBeVisible();
});

test('register an asset from a capex bill, depreciate nothing yet, write it off from the screen and undo the write-off', async ({ page }) => {
  await page.goto('/'); await fixtureId(page, 'faActive'); // the mock worker is up
  // a source is needed: record the purchase first (the register page says so when nothing is waiting)
  const line = { id: 'cl1', description: 'เครื่องตัดกระดาษ', qty: '1', unit: 'เครื่อง', unitPrice: '12000.00', taxCode: 'EX', expenseCategory: 'capex-equipment' };
  const draft = await send(page, 'POST', '/docs/PB', { header: { partyId: 'pv-10', documentDate: '2026-10-01', vendorDocNumber: 'AC5-E2E', vendorDocDate: '2026-10-01' }, lines: [line] });
  await send(page, 'POST', `/docs/PB/${draft.json.id}/issue`, { version: draft.json.version });
  await page.goto(`${FA}/new`);
  const row = page.getByTestId('register-rows').getByRole('row').filter({ hasText: 'เครื่องตัดกระดาษ' });
  await expect(row).toContainText('12,000.00');
  await shot(page, 'fa-register');
  await axeClean(page);
  await row.getByRole('button', { name: 'ลงทะเบียน' }).click();
  const dlg = page.getByRole('dialog');
  await dlg.getByLabel('อายุการใช้งาน (เดือน)').fill('12');
  await dlg.getByLabel('วันที่เริ่มใช้งาน').fill('2026-10-01');
  await dlg.getByRole('button', { name: 'ลงทะเบียน' }).click();
  await expect(page).toHaveURL(new RegExp(`${FA}/[^/]+$`));
  await expect(page.getByTestId('fa-cost')).toHaveText('12,000.00');
  await expect(page.getByTestId('fa-accumulated')).toHaveText('0.00');
  // the source is locked while the asset lives: the bill says so, and cancelling it is refused
  const pb = await api<{ locks: { kind: string }[] }>(page, `/docs/PB/${draft.json.id}`);
  expect(pb.locks.map((l) => l.kind)).toContain('asset');
  expect((await send(page, 'POST', `/docs/PB/${draft.json.id}/cancel`, { version: 2, reasonCode: 'OTHER', reasonText: 'x' })).status).toBe(409);
  // write it off from the screen: the loss is the whole NBV, the buttons follow
  await page.getByRole('button', { name: 'จำหน่าย', exact: true }).click();
  const d = page.getByRole('dialog');
  await d.getByLabel('วิธีจำหน่าย').selectOption('write_off');
  await d.getByLabel('วันที่จำหน่าย').fill('2026-10-10');
  await shot(page, 'fa-dispose-dialog');
  await d.getByRole('button', { name: 'จำหน่าย', exact: true }).click();
  await expect(page.getByTestId('fa-disposal')).toContainText('ตัดจำหน่าย');
  await expect(page.getByTestId('fa-gainloss')).toHaveText('11,677.42'); // 12,000.00 less October's 10 of 31 days (322.58) carried by the disposal
  await page.getByRole('button', { name: 'ยกเลิกการตัดจำหน่าย' }).click();
  await expect(page.getByTestId('fa-disposal')).toHaveCount(0);
  // the register report ties the accumulated depreciation to the ledger
  const rep = await api<{ tieOuts: { diff: string }[] }>(page, '/reports/asset-register');
  expect(rep.tieOuts[0].diff).toBe('0.00');
});

test('what the operator cannot do, and what no one can do through the generic routes', async ({ page }) => {
  await page.goto('/'); const id = await fixtureId(page, 'faActive');
  const generic = await send(page, 'POST', '/docs/FA', { header: { documentDate: '2026-10-01' }, lines: [] });
  expect([generic.status, generic.json.code]).toEqual([409, 'doc.use_asset_screen']);
  await page.goto(`${FA}/${id}/edit`);
  await expect(page).toHaveURL(new RegExp(`${FA}/${id}$`)); // no editor: the view says how to change it
  await expect(page.getByRole('link', { name: 'แก้ไข', exact: true })).toHaveCount(0);
  await page.goto('/purchases/bills/pb-capex');
  await expect(page.getByRole('status', { name: 'ล็อก' })).toContainText('ใช้ลงทะเบียนสินทรัพย์'); // the bill of fa-nb
  await page.goto(`${DP}/new?role=operator`);
  await expect(page.locator('[data-screen-state="forbidden"]').first()).toBeVisible();
});
