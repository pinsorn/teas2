import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Doc } from '@/domain/types';
import { setSettings } from '@/mocks/settings';
import { loadState, resetState } from '@/mocks/store';
import { testServer } from '@/mocks/test-server';
import { QuickBillDialog } from './QuickBillDialog';

vi.mock('next/navigation', () => import('@/test/next-navigation'));
beforeAll(() => testServer.listen({ onUnhandledFrame: 'error' }));
afterEach(async () => { cleanup(); await new Promise((r) => setTimeout(r, 150)); testServer.resetHandlers(); });
afterAll(() => testServer.close());
beforeEach(() => { localStorage.clear(); resetState(); setSettings({ companyKey: 'vat', role: 'accountant', screenState: 'normal' }); });

const mount = (partyId: string, partyName: string, onCreated = vi.fn(), seed = {}) => {
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <QuickBillDialog open onClose={() => {}} partyId={partyId} partyName={partyName} seed={seed} onCreated={onCreated} />
  </QueryClientProvider>);
  return onCreated;
};
const fill = async (number: string, amount: string) => {
  await userEvent.type(await screen.findByLabelText('เลขที่เอกสารของผู้ขาย'), number);
  await userEvent.type(screen.getByLabelText('รายการ'), 'ค่าบริการ');
  await userEvent.type(screen.getByLabelText('จำนวนเงินก่อนภาษี'), amount);
};

describe('QuickBillDialog (D-16)', () => {
  it('creates AND issues a real PB through the bill API: the vendor VAT snapshot, the claim period and the category are the server\'s', async () => {
    const onCreated = mount('pv-01', 'บริษัท ภูพานกระดาษ จำกัด');
    await fill('QB-1', '1000');
    await userEvent.selectOptions(screen.getByLabelText('หมวดค่าใช้จ่าย'), 'services');
    await userEvent.click(screen.getByRole('button', { name: 'บันทึกและใช้กับใบสำคัญจ่ายนี้' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalled(), { timeout: 8000 });
    const bill = onCreated.mock.calls[0][0] as Doc;
    expect(bill).toMatchObject({ type: 'PB', status: 'issued', totals: { net: '1000.00', vat: '70.00', total: '1070.00' }, outstanding: '1070.00' });
    expect(bill.number).toMatch(/^PB-\d{6}-\d{4}$/);
    expect(bill.header).toMatchObject({ vendorDocNumber: 'QB-1', vendorVatRegistered: true, claimPeriod: expect.stringMatching(/^\d{4}-\d{2}$/) });
    expect(bill.lines[0]).toMatchObject({ expenseCategory: 'services' });
  }, 20000);

  it('an unregistered vendor with VAT is refused by the server (ม.82/5) and no bill is left behind', async () => {
    const before = loadState().docs.filter((d) => d.type === 'PB').length;
    const onCreated = mount('pv-09', 'คุณอนันต์ ภาพดี (ช่างภาพอิสระ)');
    await fill('QB-2', '1000');
    await userEvent.click(screen.getByRole('button', { name: 'บันทึกและใช้กับใบสำคัญจ่ายนี้' }));
    expect(await screen.findByRole('alert', {}, { timeout: 8000 })).toHaveTextContent('ไม่ได้จดทะเบียนภาษีมูลค่าเพิ่ม');
    expect(onCreated).not.toHaveBeenCalled();
    expect(loadState().docs.filter((d) => d.type === 'PB')).toHaveLength(before);
  }, 20000);

  it('the same vendor with the no-VAT code records and issues', async () => {
    const onCreated = mount('pv-09', 'คุณอนันต์ ภาพดี (ช่างภาพอิสระ)');
    await fill('QB-3', '1000');
    await userEvent.selectOptions(screen.getByLabelText('รหัสภาษี'), 'EX');
    await userEvent.click(screen.getByRole('button', { name: 'บันทึกและใช้กับใบสำคัญจ่ายนี้' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalled(), { timeout: 8000 });
    expect((onCreated.mock.calls[0][0] as Doc).totals).toMatchObject({ vat: '0.00', total: '1000.00' });
  }, 20000);

  it('is seeded from the refused voucher line (amount, tax code, category, WHT type)', async () => {
    mount('pv-01', 'บริษัท ภูพานกระดาษ จำกัด', vi.fn(), { description: 'ค่าที่ปรึกษา', amount: '2500.00', taxCode: 'S7', category: 'services' });
    expect(await screen.findByLabelText('จำนวนเงินก่อนภาษี')).toHaveValue('2500.00');
    expect(screen.getByLabelText('รายการ')).toHaveValue('ค่าที่ปรึกษา');
    expect(screen.getByLabelText('รหัสภาษี')).toHaveValue('S7');
    expect(screen.getByLabelText('หมวดค่าใช้จ่าย')).toHaveValue('services');
  });
});
