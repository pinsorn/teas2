import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Doc, DocType } from '@/domain/types';
import { setSettings } from '@/mocks/settings';
import { loadState, resetState } from '@/mocks/store';
import { testServer } from '@/mocks/test-server';
import { ConvertDialog } from './ConvertDialog';

vi.mock('next/navigation', () => import('@/test/next-navigation'));
beforeAll(() => testServer.listen({ onUnhandledFrame: 'error' }));
afterEach(() => testServer.resetHandlers());
afterAll(() => testServer.close());
beforeEach(() => { localStorage.clear(); resetState(); setSettings({ companyKey: 'vat', role: 'accountant', screenState: 'normal' }); });

Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => {};
Element.prototype.releasePointerCapture ??= () => {};
Element.prototype.scrollIntoView ??= () => {};

const source = (id: string): Doc => { const { companyId, ...d } = loadState().docs.find((x) => x.id === id)!; void companyId; return d; };
const open = (id: string, onDone = vi.fn(), onClose = vi.fn()) => {
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <ConvertDialog source={source(id)} targets={['SO', 'TI', 'IV']} onDone={onDone} onClose={onClose} />
  </QueryClientProvider>);
  return { onDone, onClose };
};
const options = async () => {
  const select = await screen.findByLabelText('เอกสารปลายทาง');
  return within(select).getAllByRole('option').map((o) => (o as HTMLOptionElement).value);
};
const types = (ids: DocType[]) => ids;

describe('ConvertDialog', () => {
  it('offers only targets available to the company and permitted to the role (TI hidden on non-VAT, IV hidden on VAT)', async () => {
    open('qt-acc');
    expect(await options()).toEqual(types(['SO', 'TI']));
  });
  it('a non-VAT company is offered SO and IV, not TI', async () => {
    setSettings({ companyKey: 'nonvat', role: 'operator' });
    open('nqt-2');
    expect(await options()).toEqual(types(['SO', 'IV']));
  });
  it('a role without the create permission of a target does not see it', async () => {
    setSettings({ role: 'accountant' });
    const { PERMISSIONS_BY_ROLE } = await import('@/mocks/permissions');
    const saved = PERMISSIONS_BY_ROLE.accountant;
    PERMISSIONS_BY_ROLE.accountant = saved.filter((p) => p !== 'doc.TI.create');
    try { open('qt-acc'); expect(await options()).toEqual(types(['SO'])); } finally { PERMISSIONS_BY_ROLE.accountant = saved; }
  });

  it('qty defaults to the server remaining text; 0 drops the line; over-conversion error shown inline', async () => {
    const user = userEvent.setup();
    const { onDone } = open('qt-acc');
    const dlg = await screen.findByRole('dialog', { name: /แปลงใบเสนอราคา/ });
    await within(dlg).findAllByRole('spinbutton');
    const qty = within(dlg).getAllByRole('spinbutton') as HTMLInputElement[];
    expect(qty.map((i) => i.value)).toEqual(['10', '20']); // the server's remaining text, as is
    // over-conversion: the server's refusal is shown in the dialog, the dialog stays open and nothing is created
    await user.clear(qty[0]); await user.type(qty[0], '11');
    await user.click(within(dlg).getByRole('button', { name: 'สร้างใบสั่งขาย' }));
    expect(await within(dlg).findByRole('alert')).toHaveTextContent(/เกินจำนวนคงเหลือ.*เหลือ 10/);
    expect(onDone).not.toHaveBeenCalled();
    expect(loadState().docs.filter((d) => d.type === 'SO' && d.lines.some((l) => l.sourceLineId?.startsWith('qt-acc')))).toHaveLength(0);
    // 0 drops the line; the rest converts
    await user.clear(qty[0]); await user.type(qty[0], '3');
    await user.clear(qty[1]); await user.type(qty[1], '0');
    await user.click(within(dlg).getByRole('button', { name: 'สร้างใบสั่งขาย' }));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    const created = onDone.mock.calls[0][0] as Doc;
    expect([created.type, created.status, created.lines.map((l) => [l.sourceLineId, l.qty])]).toEqual(['SO', 'draft', [['qt-acc-l1', '3']]]);
  });
  it('all quantities 0: nothing to convert, the button is disabled', async () => {
    const user = userEvent.setup();
    open('qt-acc');
    const dlg = await screen.findByRole('dialog', { name: /แปลงใบเสนอราคา/ });
    await within(dlg).findAllByRole('spinbutton');
    for (const i of within(dlg).getAllByRole('spinbutton')) { await user.clear(i); await user.type(i, '0'); }
    expect(within(dlg).getByRole('button', { name: 'สร้างใบสั่งขาย' })).toBeDisabled();
  });
  it('shows what was already converted: a second dialog defaults to the new remaining', async () => {
    const user = userEvent.setup();
    const first = open('qt-acc');
    let dlg = await screen.findByRole('dialog', { name: /แปลงใบเสนอราคา/ });
    await within(dlg).findAllByRole('spinbutton');
    const [a] = within(dlg).getAllByRole('spinbutton') as HTMLInputElement[];
    await user.clear(a); await user.type(a, '4');
    await user.click(within(dlg).getByRole('button', { name: 'สร้างใบสั่งขาย' }));
    await waitFor(() => expect(first.onDone).toHaveBeenCalled());
    cleanup();
    open('qt-acc');
    dlg = await screen.findByRole('dialog', { name: /แปลงใบเสนอราคา/ });
    await waitFor(() => expect((within(dlg).getAllByRole('spinbutton') as HTMLInputElement[]).map((i) => i.value)).toEqual(['6', '0'])); // line 2 went across in full the first time
  });
});
