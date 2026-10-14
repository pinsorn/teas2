import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

/** Zero serious/critical axe violations on the page as it is right now (open dialogs included).
 *  Finite animations (a dialog fading in) are allowed to finish first: axe reads the mid-fade colours otherwise (flaky contrast hit). */
export async function axeClean(page: Page) {
  await page.evaluate(() => Promise.all(document.getAnimations()
    .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
    .map((a) => a.finished.catch(() => undefined))));
  const r = await new AxeBuilder({ page }).analyze();
  expect(r.violations.filter((v) => ['serious', 'critical'].includes(v.impact ?? '')).map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);
}
