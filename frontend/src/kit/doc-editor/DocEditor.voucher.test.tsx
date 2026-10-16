import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { paymentVoucher } from '@/descriptors/payment-voucher';
import { setSettings } from '@/mocks/settings';
import { resetState } from '@/mocks/store';
import { testServer } from '@/mocks/test-server';
import { DocEditor } from './DocEditor';

vi.mock('next/navigation', () => import('@/test/next-navigation'));
beforeAll(() => testServer.listen({ onUnhandledFrame: 'error' }));
afterEach(async () => { cleanup(); await new Promise((r) => setTimeout(r, 150)); testServer.resetHandlers(); });
afterAll(() => testServer.close());
beforeEach(() => { localStorage.clear(); resetState(); setSettings({ companyKey: 'vat', role: 'accountant', screenState: 'normal' }); });

const ui = (onIssued = vi.fn()) => {
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><DocEditor descriptor={paymentVoucher} mode="create" onIssued={onIssued} /></QueryClientProvider>);
  return onIssued;
};
const totals = () => screen.getByRole('region', { name: 'ยอดรวม' });
const quick = 'บันทึกซื้อ (มีใบกำกับภาษี)';

describe('PV editor: the standalone taxed line and the quick bill (D-16)', () => {
  it('a taxed line is refused with a banner naming the quick-bill button; the dialog makes a PB, the voucher pays it and the taxed line is gone', async () => {
    const onIssued = ui();
    await userEvent.type(screen.getByRole('combobox', { name: 'ผู้ขาย' }), 'ภูพาน{Enter}');
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'ผู้ขาย' })).toHaveValue('บริษัท ภูพานกระดาษ จำกัด'), { timeout: 12000 });
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'ภาษีรายการ 1' }), 'S7');
    await userEvent.type(screen.getByRole('combobox', { name: 'รายการ 1' }), 'ค่าที่ปรึกษา');
    await userEvent.type(screen.getByRole('textbox', { name: 'จำนวนเงินรายการ 1' }), '1000');
    const banner = await screen.findByTestId('pv-needs-bill', {}, { timeout: 12000 });
    expect(banner).toHaveTextContent(quick);
    await userEvent.click(within(banner).getByRole('button', { name: quick }));
    const dlg = await screen.findByRole('alertdialog');
    expect(within(dlg).getByLabelText('จำนวนเงินก่อนภาษี')).toHaveValue('1000.00'); // seeded from the refused line
    expect(within(dlg).getByLabelText('รายการ')).toHaveValue('ค่าที่ปรึกษา');
    await userEvent.type(within(dlg).getByLabelText('เลขที่เอกสารของผู้ขาย'), 'QB-E1');
    await userEvent.click(within(dlg).getByRole('button', { name: 'บันทึกและใช้กับใบสำคัญจ่ายนี้' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull(), { timeout: 12000 });
    expect(await screen.findByRole('checkbox', { checked: true }, { timeout: 12000 })).toBeInTheDocument(); // the allocation of the new bill
    await waitFor(() => expect(screen.queryByTestId('pv-needs-bill')).toBeNull(), { timeout: 12000 });
    await waitFor(() => expect(totals()).toHaveTextContent('1,070.00'), { timeout: 12000 }); // the bill's total, the server's figure
    await waitFor(() => expect(screen.getByRole('region', { name: 'ยังขาดอะไร' })).toHaveTextContent('ครบแล้ว'), { timeout: 12000 });
    await userEvent.click(screen.getByRole('button', { name: 'บันทึกและออกใบสำคัญจ่าย' }));
    await screen.findByRole('alertdialog', {}, { timeout: 8000 });
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(onIssued).toHaveBeenCalledWith(expect.objectContaining({ type: 'PV', status: 'issued', allocations: [expect.objectContaining({ targetType: 'PB', amount: '1070.00' })] })), { timeout: 8000 });
  }, 60000);

  it('a vendor with no refusal still offers the quick-bill button next to the open items', async () => {
    ui();
    expect(screen.queryByRole('button', { name: quick })).toBeNull(); // no vendor yet
    await userEvent.type(screen.getByRole('combobox', { name: 'ผู้ขาย' }), 'ภูพาน{Enter}');
    expect(await screen.findByRole('button', { name: quick }, { timeout: 12000 })).toBeInTheDocument();
    expect(screen.queryByTestId('pv-needs-bill')).toBeNull();
  }, 30000);

  it('a foreign payee: the header takes gross-up every time and a service line defaults to FOR-SVC (editable)', async () => {
    ui();
    await userEvent.type(screen.getByRole('combobox', { name: 'ผู้ขาย' }), 'Cloudberry{Enter}');
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'ผู้ขาย' })).toHaveValue('Cloudberry Software Ltd. (ไอร์แลนด์)'), { timeout: 12000 });
    expect(screen.getByRole('combobox', { name: 'ผู้รับภาระภาษีหัก ณ ที่จ่าย' })).toHaveValue('grossup_always');
    await userEvent.type(screen.getByRole('combobox', { name: 'รายการ 1' }), 'ค่าซอฟต์แวร์');
    await userEvent.type(screen.getByRole('textbox', { name: 'จำนวนเงินรายการ 1' }), '10000');
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'หัก ณ ที่จ่ายรายการ 1' })).toHaveDisplayValue(/ค่าบริการจ่ายต่างประเทศ/), { timeout: 12000 });
    await waitFor(() => expect(totals()).toHaveTextContent('1,764.71'), { timeout: 12000 }); // 10,000.00 / (1 - 15 %) x 15 %, borne by us
  }, 40000);
});
