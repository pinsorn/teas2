import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { USER } from '@/mocks/fixtures/documents';
import { createDraft, issue } from '@/mocks/engine/commands';
import { setSettings } from '@/mocks/settings';
import { loadState, resetState, saveState } from '@/mocks/store';
import { testServer } from '@/mocks/test-server';
import { __setSearch } from '@/test/next-navigation';
import type { DocLine } from '@/domain/types';
import { DocNewPage } from './DocNewPage';

vi.mock('next/navigation', () => import('@/test/next-navigation'));
beforeAll(() => testServer.listen({ onUnhandledFrame: 'error' }));
afterEach(async () => { cleanup(); await new Promise((r) => setTimeout(r, 150)); testServer.resetHandlers(); });
afterAll(() => testServer.close());
beforeEach(() => { localStorage.clear(); resetState(); __setSearch(''); setSettings({ companyKey: 'vat', role: 'accountant', screenState: 'normal' }); });

const mount = (type: 'CN' | 'DN') => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><DocNewPage type={type} /></QueryClientProvider>);
const qty = (n: number) => screen.findByRole('textbox', { name: new RegExp(`^จำนวน ${n}$`) }) as Promise<HTMLInputElement>;
const price = (n: number) => screen.findByRole('textbox', { name: new RegExp(`^ราคาต่อหน่วย ${n}$`) }) as Promise<HTMLInputElement>;

/** A TI of two lines (2 x 100.00, 1 x 50.00) with a partial and a full credit already issued. */
function tiWithCredits(): string {
  const st = loadState();
  const party = st.docs.find((d) => d.id === 'ti-007')!.header.partyId!;
  const L = (id: string, q: string, p: string): DocLine => ({ id, description: `รายการ ${id}`, qty: q, unit: 'ชิ้น', unitPrice: p, taxCode: 'S7' });
  const d = createDraft(st, 'co-vat', 'TI', { header: { partyId: party, documentDate: '2026-10-01' }, lines: [L('l1', '2', '100.00'), L('l2', '1', '50.00')] }, USER, 'adj-ti');
  const t = issue(st, d.id, d.version, USER);
  const note = (lines: DocLine[]) => { const c = createDraft(st, 'co-vat', 'CN', { header: { documentDate: '2026-10-14', refDocId: t.id, reasonCode: 'RETURN' }, lines }, USER, `adj-cn-${lines[0].id}`); issue(st, c.id, c.version, USER); };
  note([{ ...L('a', '1', '100.00'), sourceLineId: 'l1' }]); // half of l1
  note([{ ...L('b', '1', '50.00'), sourceLineId: 'l2' }]); // all of l2
  saveState(st);
  return t.id;
}

describe('M2: the note editor opened from an invoice', () => {
  it('a CN is prefilled with what is still creditable of each line; a fully credited line is left out', async () => {
    __setSearch(`adjust=${tiWithCredits()}`);
    mount('CN');
    await waitFor(async () => expect((await price(1)).value).toBe('100.00'), { timeout: 4000 });
    expect((await qty(1)).value).toBe('1'); // l1: 200.00 sold, 100.00 credited -> 100.00 left
    expect(screen.queryByRole('textbox', { name: /^จำนวน 2$/ })).toBeNull(); // l2 is credited in full
  });
  it('a CN of an invoice nothing was credited on keeps its lines as sold', async () => {
    __setSearch('adjust=ti-007');
    mount('CN');
    expect((await qty(1)).value).toBe('2');
  });
  it('a DN starts every line at quantity 0 (saving it unedited must not double the invoice)', async () => {
    __setSearch('adjust=ti-007');
    mount('DN');
    expect((await qty(1)).value).toMatch(/^0(\.0+)?$/);
  });
});
