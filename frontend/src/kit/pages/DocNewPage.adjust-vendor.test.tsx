import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocLine } from '@/domain/types';
import { createDraft, issue } from '@/mocks/engine/commands';
import { USER } from '@/mocks/fixtures/documents';
import { setSettings } from '@/mocks/settings';
import { loadState, resetState, saveState } from '@/mocks/store';
import { testServer } from '@/mocks/test-server';
import { __setSearch } from '@/test/next-navigation';
import { DocNewPage } from './DocNewPage';

vi.mock('next/navigation', () => import('@/test/next-navigation'));
beforeAll(() => testServer.listen({ onUnhandledFrame: 'error' }));
afterEach(async () => { cleanup(); await new Promise((r) => setTimeout(r, 150)); testServer.resetHandlers(); });
afterAll(() => testServer.close());
beforeEach(() => { localStorage.clear(); resetState(); __setSearch(''); setSettings({ companyKey: 'vat', role: 'accountant', screenState: 'normal' }); });

const mount = (type: 'PCN' | 'PDN') => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><DocNewPage type={type} /></QueryClientProvider>);
const qty = (n: number) => screen.findByRole('textbox', { name: new RegExp(`^จำนวน ${n}$`) }) as Promise<HTMLInputElement>;
const price = (n: number) => screen.findByRole('textbox', { name: new RegExp(`^ราคาต่อหน่วย ${n}$`) }) as Promise<HTMLInputElement>;

/** An issued PB of one line, ex-VAT or priced with VAT. */
function bill(unitPrice: string, inclusive: boolean): string {
  const st = loadState();
  const L: DocLine = { id: 'l1', description: 'ค่าเช่า', qty: '1', unit: 'เดือน', unitPrice, taxCode: 'S7', expenseCategory: 'rent' };
  const d = createDraft(st, 'co-vat', 'PB', { header: { partyId: 'pv-01', documentDate: '2026-10-01', ...(inclusive ? { priceIncludesVat: true } : {}) }, lines: [L] }, USER, `v-pb-${unitPrice}`);
  const b = issue(st, d.id, d.version, USER);
  saveState(st);
  return b.id;
}

describe('the vendor note editor opened from a purchase bill', () => {
  it('a PCN of pb-2 offers every line as billed (the debit note pdn-1 does not shrink what can be credited) and says the vendor is the bill\'s', async () => {
    __setSearch('adjust=pb-2');
    mount('PCN');
    expect((await price(1)).value).toBe('18000.00');
    expect((await price(2)).value).toBe('4500.00');
    expect((await qty(1)).value).toBe('1');
    expect(screen.getByText('ผู้ขายตามบันทึกซื้อที่อ้างอิง')).toBeVisible();
    expect((screen.getByLabelText('บันทึกซื้อที่อ้างอิง') as HTMLInputElement).value).toMatch(/^PB-\d{6}-\d{4} · /);
  });
  it('a PCN of a bill already credited in part (pb-1: pcn-1 took 2,500.00 of 25,000.00) offers 1 x what is left', async () => {
    __setSearch('adjust=pb-1');
    mount('PCN');
    await waitFor(async () => expect((await price(1)).value).toBe('22500.00'), { timeout: 6000 });
    expect((await qty(1)).value).toBe('1');
  });
  it('a PDN starts every line at quantity 0', async () => {
    __setSearch('adjust=pb-2');
    mount('PDN');
    expect((await qty(1)).value).toMatch(/^0(\.0+)?$/);
  });
  it('a bill priced WITH VAT is read through the server nets: the PCN offers 1 x the line NET (100.00 of 107.00), the PDN 0 x it', async () => {
    const id = bill('107.00', true);
    __setSearch(`adjust=${id}`);
    mount('PCN');
    await waitFor(async () => expect((await price(1)).value).toBe('100.00'), { timeout: 6000 });
    expect((await qty(1)).value).toBe('1');
    cleanup();
    mount('PDN');
    await waitFor(async () => expect((await price(1)).value).toBe('100.00'), { timeout: 6000 });
    expect((await qty(1)).value).toMatch(/^0(\.0+)?$/);
  });
  it('without a bill the editor asks for one first (purchase bills, not tax invoices)', async () => {
    mount('PCN');
    expect(await screen.findByRole('heading', { level: 1, name: /เลือกบันทึกซื้อที่จะบันทึกใบลดหนี้จากผู้ขาย/ })).toBeVisible();
    expect((await screen.findAllByRole('link', { name: /เลือก PB-/ })).length).toBeGreaterThan(0);
  });
});
