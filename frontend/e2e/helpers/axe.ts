import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

/** Zero serious/critical axe violations on the page as it is right now (open dialogs included).
 *  Waits for a settled page first: a non-empty document.title (navigation done) and no finite animation / transition
 *  still running (axe reads mid-fade colours otherwise: flaky contrast hit). Bounded at ~2 s. */
export async function axeClean(page: Page) {
  await page.waitForFunction(() => document.title.trim() !== '', undefined, { timeout: 5000 });
  await page.evaluate(async () => {
    const frames = () => new Promise<void>((res) => requestAnimationFrame(() => requestAnimationFrame(() => res())));
    const end = performance.now() + 2000;
    const within = <T,>(p: Promise<T>) => Promise.race([p, new Promise<void>((res) => setTimeout(res, Math.max(0, end - performance.now())))]); // a long or paused animation never blocks past the budget
    for (;;) {
      await within(frames());
      const running = document.getAnimations().filter((a) => a.playState === 'running' && a.effect?.getComputedTiming().iterations !== Infinity);
      if (running.length === 0 || performance.now() > end) return;
      await within(Promise.all(running.map((a) => a.finished.catch(() => undefined))));
    }
  });
  const r = await new AxeBuilder({ page }).analyze();
  expect(r.violations.filter((v) => ['serious', 'critical'].includes(v.impact ?? '')).map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);
}
