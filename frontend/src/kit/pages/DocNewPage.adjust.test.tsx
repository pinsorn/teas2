import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { USER } from '@/mocks/fixtures/documents';
import userEvent from '@testing-library/user-event';
import { createDraft, issue } from '@/mocks/engine/commands';
import { correctionPlan, executePlan } from '@/mocks/engine/corrections';
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

describe('R4: a debit note drops its untouched quantity-0 lines before saving', () => {
  it('with every line at 0 the editor says a line is missing (its own item, not the server\'s per-line error); one real line is enough', async () => {
    __setSearch('adjust=ti-007');
    mount('DN');
    const region = await screen.findByRole('region', { name: 'ยังขาดอะไร' });
    await waitFor(() => expect(region).toHaveTextContent('ต้องมีรายการอย่างน้อย 1 รายการ'), { timeout: 6000 });
    expect(region).not.toHaveTextContent('ต้องมียอดมากกว่า');
    const q = await qty(1);
    await userEvent.clear(q);
    await userEvent.type(q, '1');
    await userEvent.tab();
    await waitFor(() => expect(screen.getByRole('region', { name: 'ยังขาดอะไร' })).not.toHaveTextContent('ต้องมีรายการอย่างน้อย 1 รายการ'), { timeout: 6000 });
    expect(screen.getByRole('region', { name: 'ยังขาดอะไร' })).not.toHaveTextContent('ต้องมียอดมากกว่า'); // the other zero lines are not sent
  });
});

describe('R1: after a plan that moved one line down and another up, the CN is prefilled with what is left', () => {
  it('l1 100 -> 70 and l2 100 -> 200: the CN offers l1 at 70.00 and l2 as sold', async () => {
    const st = loadState();
    const party = st.docs.find((d) => d.id === 'ti-007')!.header.partyId!;
    const L = (id: string, tax: DocLine['taxCode'], p: string): DocLine => ({ id, description: `รายการ ${id}`, qty: '1', unit: 'ชิ้น', unitPrice: p, taxCode: tax });
    const d = createDraft(st, 'co-vat', 'TI', { header: { partyId: party, documentDate: '2026-10-01' }, lines: [L('l1', 'S7', '100.00'), L('l2', 'Z0', '100.00')] }, USER, 'r1-ti');
    const t = issue(st, d.id, d.version, USER);
    const plan = correctionPlan(st, t.id, { header: t.header, lines: [L('l1', 'S7', '70.00'), L('l2', 'Z0', '200.00')] }, 'accountant');
    executePlan(st, plan.planId, plan.planHash, USER);
    saveState(st);
    __setSearch(`adjust=${t.id}`);
    mount('CN');
    await waitFor(async () => expect((await price(1)).value).toBe('70.00'), { timeout: 6000 });
    expect((await price(2)).value).toBe('100.00');
  });
});

describe('R1 belt and braces: a stored DN with a negative referenced line is a credit in the prefill', () => {
  it('DN l1 -30.00 -> the CN offers l1 at 70.00', async () => {
    const st = loadState();
    const party = st.docs.find((d) => d.id === 'ti-007')!.header.partyId!;
    const L = (id: string, p: string, x: Partial<DocLine> = {}): DocLine => ({ id, description: `รายการ ${id}`, qty: '1', unit: 'ชิ้น', unitPrice: p, taxCode: 'S7', ...x });
    const d = createDraft(st, 'co-vat', 'TI', { header: { partyId: party, documentDate: '2026-10-01' }, lines: [L('l1', '100.00')] }, USER, 'r1b-ti');
    const t = issue(st, d.id, d.version, USER);
    const n = createDraft(st, 'co-vat', 'DN', { header: { documentDate: '2026-10-14', refDocId: t.id, reasonCode: 'PRICE_INCREASE' }, lines: [L('a', '-30.00', { sourceLineId: 'l1', vatOverride: '-2.10' }), L('b', '100.00', { taxCode: 'Z0', vatOverride: '0.00' })] }, USER, 'r1b-dn'); // a mixed stored note: -30 on l1, +100 of its own
    issue(st, n.id, n.version, USER);
    saveState(st);
    __setSearch(`adjust=${t.id}`);
    mount('CN');
    await waitFor(async () => expect((await price(1)).value).toBe('70.00'), { timeout: 6000 });
  });
});
