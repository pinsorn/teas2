import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { quotation } from '@/descriptors/quotation';
import { setSettings } from '@/mocks/settings';
import { loadState, resetState } from '@/mocks/store';
import { testServer } from '@/mocks/test-server';
import { useRouter } from 'next/navigation';
import { DocView } from './DocView';

vi.mock('next/navigation', () => import('@/test/next-navigation'));
beforeAll(() => testServer.listen({ onUnhandledFrame: 'error' }));
afterEach(() => testServer.resetHandlers());
afterAll(() => testServer.close());
beforeEach(() => { localStorage.clear(); resetState(); setSettings({ companyKey: 'vat', role: 'accountant', screenState: 'normal' }); });

Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => {};
Element.prototype.releasePointerCapture ??= () => {};
Element.prototype.scrollIntoView ??= () => {};
const ui = (id: string) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><DocView descriptor={quotation} id={id} /></QueryClientProvider>);

describe('DocView: quotation marks and conversion', () => {
  it('a rejected QT shows its mark, the reason, the exit, and a disabled convert button', async () => {
    ui('qt-rej');
    expect(await screen.findByText(/แก้ไขเป็นฉบับใหม่หรือคัดลอกเป็นใบใหม่/)).toBeVisible();
    expect(screen.getByText(/ราคาสูงกว่างบประมาณ/)).toBeVisible();
    expect(document.querySelector('[data-mark="rejected"]')).toHaveTextContent('ปฏิเสธ');
    expect(screen.getByRole('button', { name: 'แปลงเป็น…' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'ลูกค้าปฏิเสธ' })).toBeNull(); // already rejected: only "accepted" is left to offer
    expect(screen.getByRole('button', { name: 'ลูกค้าตอบรับ' })).toBeEnabled();
  });
  it('recording the customer\'s acceptance adds the chip and the activity line, with no new revision', async () => {
    const user = userEvent.setup();
    ui('qt-r1');
    await user.click(await screen.findByRole('button', { name: 'ลูกค้าตอบรับ' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'บันทึก' }));
    await waitFor(() => expect(document.querySelector('[data-mark="accepted"]')).not.toBeNull());
    const d = loadState().docs.find((x) => x.id === 'qt-r1')!;
    expect([d.revision, d.marks?.accepted !== undefined]).toEqual([1, true]);
    expect(loadState().revisions.filter((r) => r.docId === 'qt-r1')).toHaveLength(2);
  });
  it('converting lands on the new draft\'s edit route (SO screens are not built yet: the nav route)', async () => {
    const user = userEvent.setup();
    ui('qt-acc');
    await user.click(await screen.findByRole('button', { name: 'แปลงเป็น…' }));
    const dlg = await screen.findByRole('dialog', { name: /แปลงใบเสนอราคา/ });
    await within(dlg).findAllByRole('spinbutton');
    await user.click(within(dlg).getByRole('button', { name: 'สร้างใบสั่งขาย' }));
    await waitFor(() => expect(useRouter().push).toHaveBeenCalledWith(expect.stringMatching(/^\/sales\/sales-orders\/doc-so-\d+\/edit$/)));
  });
  it('"convert to…" is disabled with the reason when no target is both available to the company and permitted', async () => {
    setSettings({ role: 'operator', companyKey: 'nonvat' });
    const { PERMISSIONS_BY_ROLE } = await import('@/mocks/permissions');
    const saved = PERMISSIONS_BY_ROLE.operator;
    PERMISSIONS_BY_ROLE.operator = saved.filter((p) => !['doc.SO.create', 'doc.IV.create'].includes(p)).concat('doc.TI.create'); // TI is VAT-only: not available here
    try {
      ui('nqt-1');
      const btn = await screen.findByRole('button', { name: 'แปลงเป็น…' });
      expect(btn).toBeDisabled();
      expect(btn).toHaveAccessibleDescription(/ไม่มีเอกสารปลายทาง/);
    } finally { PERMISSIONS_BY_ROLE.operator = saved; }
  });
  it('"close remainder" is disabled with the reason on a fully delivered SO', async () => {
    setSettings({ role: 'operator', companyKey: 'nonvat' });
    const { DocView: V } = await import('./DocView');
    const { salesOrder } = await import('@/descriptors/sales-order');
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><V descriptor={salesOrder} id="nso-1" /></QueryClientProvider>);
    await screen.findByRole('button', { name: 'ปิดยอดคงเหลือ' });
    await waitFor(() => expect(screen.getByRole('button', { name: 'ปิดยอดคงเหลือ' })).toBeDisabled()); // re-queried: the guard re-mounts the button once the quantities arrive
    expect(screen.getByRole('button', { name: 'ปิดยอดคงเหลือ' })).toHaveAccessibleDescription(/แปลงครบทุกรายการแล้ว/);
  });
  it('a viewer without doc.QT.issue sees the mark buttons disabled with the reason', async () => {
    setSettings({ role: 'operator', companyKey: 'nonvat' });
    const { PERMISSIONS_BY_ROLE } = await import('@/mocks/permissions');
    const saved = PERMISSIONS_BY_ROLE.operator;
    PERMISSIONS_BY_ROLE.operator = saved.filter((p) => p !== 'doc.QT.issue');
    try { ui('nqt-1'); expect(await screen.findByRole('button', { name: 'ลูกค้าตอบรับ' })).toBeDisabled(); } finally { PERMISSIONS_BY_ROLE.operator = saved; }
  });
});
