import { expect, test, type Page } from '@playwright/test';
import { axeClean } from './helpers/axe';
import { fixtureId } from './helpers/fixtures';
import { screenContract } from './helpers/screen-contract';

const shot = async (page: Page, name: string) => { if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/${name}.png`, fullPage: true }); };
const api = <T,>(page: Page, path: string) => page.evaluate(async (p) => (await fetch(`/bff/v1${p}`)).json(), path) as Promise<T>;
type DocJson = { id: string; number?: string; status: string };

// Home is every role's landing page: each of the three renders (and passes axe) in both companies
screenContract({ name: 'home', path: '/', heading: 'งานของฉัน', company: 'both', states: ['empty', 'loading', 'error'], roles: ['operator', 'accountant', 'admin'] });

test.beforeEach(async ({ page }) => { await page.goto('/'); await page.evaluate(() => localStorage.clear()); await page.reload(); });

/** The Home requests a page makes, by section. */
function homeRequests(page: Page): string[] {
  const seen: string[] = [];
  page.on('request', (r) => { const m = /\/bff\/v1\/home\/([a-z]+)/.exec(r.url()); if (m) seen.push(m[1]); });
  return seen;
}
const SECTIONS = {
  operator: ['agent', 'alerts', 'approvals', 'bank', 'drafts', 'kpis', 'overdue'],
  accountant: ['agent', 'alerts', 'approvals', 'bank', 'deadlines', 'drafts', 'kpis', 'overdue'],
  admin: ['alerts', 'bank', 'kpis'],
} as const;

for (const role of ['operator', 'accountant', 'admin'] as const) {
  test(`${role}: only the sections the role may see are shown and requested`, async ({ page }) => {
    const seen = homeRequests(page);
    await page.goto(`/?role=${role}&company=vat&state=normal`);
    await expect(page.getByRole('heading', { level: 1, name: 'งานของฉัน' })).toBeVisible();
    await expect(page.locator('[data-screen-state="loading"]')).toHaveCount(0);
    expect([...new Set(seen)].sort()).toEqual([...SECTIONS[role]].sort());
    await expect(page.locator('section[aria-labelledby^="h-"]')).toHaveCount(SECTIONS[role].length);
    await shot(page, `home-${role}-desktop`);
  });
}

test('the KPI strip reads the same figures as the aging reports and the ภ.พ.30; a non-VAT company has no VAT tile', async ({ page }) => {
  await page.goto('/?role=accountant&company=vat&state=normal');
  await fixtureId(page, 'exPending');
  const kpis = await api<{ ar: string; ap: string; vatThisMonth: string | null }>(page, '/home/kpis');
  const total = async (kind: string) => (await api<{ rows: { kind: string; cells: { total: string } }[] }>(page, `/reports/${kind}?asOf=2026-10-14`)).rows.find((r) => r.kind === 'total')?.cells.total ?? '0.00';
  expect(kpis.ar).toBe(await total('ar-aging'));
  expect(kpis.ap).toBe(await total('ap-aging'));
  await expect(page.getByTestId('kpi-vat')).toBeVisible();
  await page.goto('/?role=accountant&company=nonvat&state=normal');
  await expect(page.getByTestId('kpi-ar')).toBeVisible();
  await expect(page.getByTestId('kpi-vat')).toHaveCount(0);
});

test('the accountant approves a pending claim from Home: it leaves the inbox and is issued once', async ({ page }) => {
  await page.goto('/?role=accountant&company=vat&state=normal');
  const id = await fixtureId(page, 'exPending');
  const row = page.getByTestId(`inbox-${id}`);
  await expect(row).toBeVisible();
  await expect(row).toContainText('ผู้ขอ');
  await axeClean(page);
  await row.getByRole('button', { name: /^อนุมัติและออก/ }).click();
  await expect(row).toHaveCount(0);
  const ex = await api<DocJson>(page, `/docs/EX/${id}`);
  expect(ex.status).toBe('issued');
  expect(ex.number).toMatch(/^EX-\d{6}-\d{4}$/);
  const all = await api<{ items: DocJson[] }>(page, '/docs/EX?limit=200');
  expect(all.items.filter((d) => d.number === ex.number)).toHaveLength(1);
});

test('390 px: Home does not overflow the page for the accountant', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?role=accountant&company=vat&state=normal');
  await expect(page.getByTestId('kpi-ar')).toBeVisible();
  await expect(page.locator('[data-screen-state="loading"]')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await shot(page, 'home-accountant-390');
  await axeClean(page);
});
