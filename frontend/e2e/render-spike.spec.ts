import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

const SPIKE = [{ id: 'spike-1', minPages: 1 }, { id: 'spike-25', minPages: 2 }, { id: 'spike-60', minPages: 3 }];
const OUT = process.env.SPIKE_OUT; // optional: keep the PDFs for a visual check

async function pdfPages(buf: Buffer) {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise;
  const texts: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const c = await (await doc.getPage(i)).getTextContent();
    texts.push(c.items.map((x) => ('str' in x ? x.str : '')).join(' '));
  }
  return texts;
}
// pdfjs returns sara am as U+0E4D U+0E32 (NFC keeps U+0E33 distinct): NFKC + whitespace strip on both sides
const norm = (s: string) => s.normalize('NFKC').replace(/\s/g, '');

for (const s of SPIKE) {
  test(`${s.id}: PDF pages = screen pages, header repeats, page x/y, signatures last`, async ({ page }) => {
    // the mock world lives in the browser: boot the app once so the seed is in storage, then open the print route
    await page.goto('/');
    await page.waitForTimeout(1000);
    await page.goto(`/print/TI/${s.id}`);
    await page.waitForSelector('[data-paper-ready="true"]');
    const screenPages = await page.locator('[data-paper-page]').count();
    const pdf = await page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true });
    if (OUT) { mkdirSync(OUT, { recursive: true }); writeFileSync(join(OUT, `${s.id}.pdf`), pdf); }
    const pages = (await pdfPages(pdf)).map(norm);
    expect(pages.length).toBe(screenPages);
    expect(pages.length).toBeGreaterThanOrEqual(s.minPages);
    pages.forEach((t, i) => {
      expect(t).toContain(norm('ใบกำกับภาษี'));
      expect(t).toContain(`${i + 1}/${pages.length}`);
      expect(t.includes(norm('ผู้มีอำนาจลงนาม'))).toBe(i === pages.length - 1);
    });
    expect(pages.at(-1)).toMatch(/บาท/);
  });
}
