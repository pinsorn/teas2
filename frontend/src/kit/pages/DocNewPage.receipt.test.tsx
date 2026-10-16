import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { USER } from '@/mocks/fixtures/documents';
import { cancel, createDraft, issue } from '@/mocks/engine/commands';
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

const mount = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><DocNewPage type="RC" /></QueryClientProvider>);
const panel = () => screen.findByRole('region', { name: 'รายการที่รับชำระ' });
const amountOf = (box: HTMLElement) => (within(box.closest('tr')!).getByRole('textbox', { name: /^จำนวนรับชำระ/ }) as HTMLInputElement).value;
const ticked = async () => {
  const p = await panel();
  await waitFor(() => expect(within(p).queryAllByRole('checkbox', { checked: true }).length).toBeGreaterThan(0), { timeout: 4000 });
  return within(p).getAllByRole('checkbox', { checked: true });
};

describe('receipt editor opened from a document (?settle= / ?fromBl=)', () => {
  it('?settle=<TI> picks its customer and ticks that invoice with the SERVER outstanding as the amount (never the document total)', async () => {
    const id = 'ti-057'; // 64,200.00 total, 1,000.00 already received by rc-multi
    expect(loadState().docs.find((d) => d.id === id)!.outstanding).toBe('63200.00');
    __setSearch(`settle=${id}`);
    mount();
    const boxes = await ticked();
    expect(boxes).toHaveLength(1);
    expect(amountOf(boxes[0])).toBe('63200.00');
    expect(await screen.findByRole('combobox', { name: 'ลูกค้า' })).toHaveValue('บริษัท นาวาพาณิชย์ จำกัด');
  });

  it('?fromBl=<BL> ticks every grouped invoice at its CURRENT outstanding, not the amount stored on the statement', async () => {
    __setSearch('fromBl=bl-1');
    mount();
    const boxes = await ticked();
    await waitFor(() => expect(within(screen.getByRole('region', { name: 'รายการที่รับชำระ' })).getAllByRole('checkbox', { checked: true })).toHaveLength(2));
    expect(boxes.length).toBeGreaterThan(0);
    const all = within(screen.getByRole('region', { name: 'รายการที่รับชำระ' })).getAllByRole('checkbox', { checked: true });
    expect(all.map(amountOf).sort()).toEqual(['63200.00', '761875.00']); // the BL stored 64,200.00 / 762,375.00 before rc-multi
  });

  it('?fromBl= skips a cancelled and a fully settled target and says which and why', async () => {
    const st = loadState();
    const pay = createDraft(st, 'co-vat', 'RC', { header: { partyId: 'pc-01', documentDate: '2026-10-14' }, lines: [], allocations: [{ targetId: 'spike-1', targetType: 'TI', amount: '1070.00' }] }, USER, 'k-pay');
    const bd = createDraft(st, 'co-vat', 'BL', { header: { partyId: 'pc-01', documentDate: '2026-10-14' }, lines: [], allocations: ['ti-057', 'spike-1', 'spike-25'].map((t) => ({ targetId: t, targetType: 'TI' as const, amount: '0.00' })) }, USER, 'k-bl');
    const bl = issue(st, bd.id, bd.version, USER); // issued while spike-1 still owes 1,070.00
    issue(st, pay.id, pay.version, USER); // spike-1 paid in full after the statement
    cancel(st, 'spike-25', st.docs.find((d) => d.id === 'spike-25')!.version, 'OTHER', 'x', USER);
    saveState(st);
    __setSearch(`fromBl=${bl.id}`);
    mount();
    const boxes = await ticked();
    expect(boxes).toHaveLength(1);
    const note = await screen.findByRole('status', { name: 'ข้ามเอกสารที่ไม่มียอดให้รับชำระ' });
    expect(note).toHaveTextContent('TI-202503-0001: รับชำระครบแล้ว');
    expect(note).toHaveTextContent('TI-202503-0002: ยกเลิกหรือถูกแทนที่แล้ว');
  });

  it('?settle= on a fully paid invoice opens an empty receipt and says why', async () => {
    const st = loadState();
    const d = createDraft(st, 'co-vat', 'RC', { header: { partyId: 'pc-01', documentDate: '2026-10-14' }, lines: [], allocations: [{ targetId: 'spike-1', targetType: 'TI', amount: '1070.00' }] }, USER, 'k1');
    issue(st, d.id, d.version, USER); saveState(st);
    __setSearch('settle=spike-1');
    mount();
    expect(await screen.findByRole('status', { name: 'ข้ามเอกสารที่ไม่มียอดให้รับชำระ' })).toHaveTextContent('รับชำระครบแล้ว');
    expect(within(await panel()).queryAllByRole('checkbox', { checked: true })).toHaveLength(0);
  });
});
