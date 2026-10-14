import type { Page } from '@playwright/test';

/** Counts user actions the way TEAS 1's audit did: a click, a typed entry, or a key press = 1. */
export function counted(page: Page) {
  let n = 0;
  return {
    get count() { return n; },
    click: async (l: ReturnType<Page['getByRole']>) => { n++; await l.click(); },
    type: async (l: ReturnType<Page['getByRole']>, text: string) => { n++; await l.pressSequentially(text); },
    press: async (key: string) => { n++; await page.keyboard.press(key); },
  };
}
