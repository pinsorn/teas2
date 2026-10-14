import { expect, test, type Page } from '@playwright/test';
import { axeClean } from './axe';

export type ScreenState = 'empty' | 'loading' | 'error' | 'forbidden' | 'locked';
type Role = 'operator' | 'accountant' | 'admin';
export interface ScreenSpec {
  name: string;
  path: string | ((page: Page) => Promise<string>);   // async form resolves fixture ids
  heading: string | RegExp;                            // the h1 in the normal state
  company: 'vat' | 'nonvat' | 'both';                  // out-of-scope company must render data-screen-state="not-available"
  states: ScreenState[];                               // each must render its data-screen-state, never together with "empty" when "error"
  forbiddenRole?: Role;                                // renders data-screen-state="forbidden" (normal state)
  roles?: Role[];                                      // normal render + axe for each (default ['accountant'])
}

const marker = (page: Page, s: string) => page.locator(`[data-screen-state="${s}"]`);

/** Declares a test.describe(spec.name, …): normal render per company x role, every declared state, out-of-scope company, forbidden role. */
export function screenContract(spec: ScreenSpec): void {
  const roles = spec.roles ?? ['accountant'];
  const inScope = spec.company === 'both' ? (['vat', 'nonvat'] as const) : ([spec.company] as const);
  const outOfScope = spec.company === 'both' ? [] : [spec.company === 'vat' ? 'nonvat' : 'vat'];

  // The path is resolved once the mock worker is up (async form uses fixture ids); the query then sets the toolbar on the next full load.
  const open = async (page: Page, q: { company: string; role: Role; state: string }) => {
    let path = spec.path;
    if (typeof path === 'function') { await page.goto('/'); path = await path(page); }
    await page.goto(`${path}${path.includes('?') ? '&' : '?'}${new URLSearchParams(q)}`);
  };

  test.describe(spec.name, () => {
    for (const company of inScope) for (const role of roles) {
      test(`${company} / ${role}: renders its heading and passes axe`, async ({ page }) => {
        await open(page, { company, role, state: 'normal' });
        await expect(page.getByRole('heading', { level: 1, name: spec.heading })).toBeVisible();
        await axeClean(page);
      });
    }
    for (const state of spec.states) {
      test(`state ${state} renders data-screen-state="${state}"`, async ({ page }) => {
        await open(page, { company: inScope[0], role: roles[0], state });
        await expect(marker(page, state).first()).toBeVisible();
        if (state === 'error') await expect(marker(page, 'empty')).toHaveCount(0); // a failure is never shown as "no data"
      });
    }
    for (const company of outOfScope) {
      test(`${company} company: not available`, async ({ page }) => {
        await open(page, { company, role: roles[0], state: 'normal' });
        await expect(marker(page, 'not-available').first()).toBeVisible();
      });
    }
    if (spec.forbiddenRole) {
      test(`${spec.forbiddenRole} is forbidden`, async ({ page }) => {
        await open(page, { company: inScope[0], role: spec.forbiddenRole!, state: 'normal' });
        await expect(marker(page, 'forbidden').first()).toBeVisible();
      });
    }
  });
}
