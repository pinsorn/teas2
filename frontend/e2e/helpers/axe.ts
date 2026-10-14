import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

/** Zero serious/critical axe violations on the page as it is right now (open dialogs included). */
export async function axeClean(page: Page) {
  const r = await new AxeBuilder({ page }).analyze();
  expect(r.violations.filter((v) => ['serious', 'critical'].includes(v.impact ?? '')).map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);
}
