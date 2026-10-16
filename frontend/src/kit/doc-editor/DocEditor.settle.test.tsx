import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { taxInvoice } from '@/descriptors/tax-invoice';
import type { DocDescriptor } from '@/domain/descriptors';
import { PERMISSIONS_BY_ROLE } from '@/mocks/permissions';
import { setSettings } from '@/mocks/settings';
import { resetState } from '@/mocks/store';
import { testServer } from '@/mocks/test-server';
import { DocEditor } from './DocEditor';

vi.mock('next/navigation', () => import('@/test/next-navigation'));
beforeAll(() => testServer.listen({ onUnhandledFrame: 'error' }));
afterEach(async () => { cleanup(); await new Promise((r) => setTimeout(r, 150)); testServer.resetHandlers(); });
afterAll(() => testServer.close());
beforeEach(() => { localStorage.clear(); resetState(); setSettings({ companyKey: 'vat', role: 'accountant', screenState: 'normal' }); });

// The voucher descriptor arrives in P3 (stub below); the receipt is a stub too, carrying exactly the fields the editor reads (same as descriptors/receipt.ts).
const perm = (t: string) => ({ read: `doc.${t}.read`, create: `doc.${t}.create`, issue: `doc.${t}.issue`, cancel: `doc.${t}.cancel`, correct: `doc.${t}.correct` });
const receipt = { ...taxInvoice, type: 'RC', titleTh: 'ใบเสร็จรับเงิน', titleEn: 'Receipt', correctionClass: 'T', vat: 'both', basePath: '/sales/receipts',
  lineEditor: 'amount', linesWhen: 'non-vat', settles: ['TI', 'IV'], permissions: perm('RC'), headerFields: ['documentDate', 'bankAccount', 'paymentMethod', 'cheque', 'reference', 'notes'] } as DocDescriptor;
const voucher = { ...taxInvoice, type: 'PV', titleTh: 'ใบสำคัญจ่าย', titleEn: 'Payment voucher', correctionClass: 'L', vat: 'both', basePath: '/purchases/payment-vouchers', partyKind: 'vendor',
  lineEditor: 'amount', settles: ['PB', 'EX'], permissions: perm('PV'), headerFields: ['documentDate', 'bankAccount', 'paymentMethod', 'cheque', 'whtMode', 'reference', 'notes'] } as DocDescriptor;

const ui = (descriptor: DocDescriptor, onIssued = vi.fn()) => {
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><DocEditor descriptor={descriptor} mode="create" onIssued={onIssued} /></QueryClientProvider>);
  return onIssued;
};
const totals = () => screen.getByRole('region', { name: 'ยอดรวม' });

describe('DocEditor: receipt in a VAT company (D-12)', () => {
  it('has no line grid, settles ticked open items, shows the server net receipt, and issues with the allocation', async () => {
    const onIssued = ui(receipt);
    await userEvent.type(screen.getByRole('combobox', { name: 'ลูกค้า' }), 'นาวา{Enter}');
    const box = (await screen.findAllByRole('checkbox'))[0];
    expect(screen.queryByRole('heading', { name: 'รายการ' })).toBeNull();
    await userEvent.click(box);
    await waitFor(() => expect(totals()).toHaveTextContent('ยอดชำระสุทธิ'), { timeout: 4000 });
    const amount = within(box.closest('tr')!).getByRole('textbox', { name: /^จำนวนรับชำระ/ });
    await waitFor(() => expect(totals()).toHaveTextContent(String((amount as HTMLInputElement).value).replace(/\B(?=(\d{3})+(?!\d))/g, ',')));
    await waitFor(() => expect(screen.getByRole('region', { name: 'ยังขาดอะไร' })).toHaveTextContent('ครบแล้ว'), { timeout: 12000 });
    await userEvent.keyboard('{Control>}{Enter}{/Control}');
    await screen.findByRole('alertdialog');
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(onIssued).toHaveBeenCalledWith(expect.objectContaining({ status: 'issued', allocations: [expect.objectContaining({ amount: (amount as HTMLInputElement).value })] })), { timeout: 6000 });
  }, 15000);

  it('picking another customer clears the ticked open items (they belonged to the first one)', async () => {
    ui(receipt);
    const party = screen.getByRole('combobox', { name: 'ลูกค้า' });
    await userEvent.type(party, 'นาวา{Enter}');
    await userEvent.click((await screen.findAllByRole('checkbox'))[0]);
    expect(screen.getAllByRole('checkbox', { checked: true })).toHaveLength(1);
    await userEvent.clear(party);
    await userEvent.type(party, 'ปิ่นทอง{Enter}');
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'ลูกค้า' })).toHaveValue('บริษัท ปิ่นทองการพิมพ์ จำกัด'));
    await waitFor(() => expect(screen.queryAllByRole('checkbox', { checked: true })).toHaveLength(0));
  });
});

describe('DocEditor: receipt deposit (the unallocated remainder)', () => {
  it('a deposit alone completes a VAT-company receipt: the server total and words, header.depositAmount normalised, issued with no allocation', async () => {
    const onIssued = ui(receipt);
    await userEvent.type(screen.getByRole('combobox', { name: 'ลูกค้า' }), 'ไทยพัฒนา{Enter}');
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'ลูกค้า' })).toHaveValue('บริษัท ไทยพัฒนาก่อสร้าง จำกัด'), { timeout: 12000 }); // the pick must land before focus moves on (a blur drops a pending Enter)
    expect(await screen.findByText(/ต้องเลือกใบกำกับภาษีที่ชำระ หรือระบุเงินรับล่วงหน้า/)).toBeVisible();
    const dep = screen.getByRole('textbox', { name: /^เงินรับล่วงหน้า/ });
    await userEvent.type(dep, '5000');
    await userEvent.tab();
    expect(dep).toHaveValue('5000.00');
    await waitFor(() => expect(totals()).toHaveTextContent('5,000.00'), { timeout: 12000 });
    expect(totals()).toHaveTextContent('ห้าพันบาทถ้วน');
    await waitFor(() => expect(screen.getByRole('region', { name: 'ยังขาดอะไร' })).toHaveTextContent('ครบแล้ว'), { timeout: 12000 });
    await userEvent.click(screen.getByRole('button', { name: 'บันทึกและออกใบเสร็จรับเงิน' }));
    await screen.findByRole('alertdialog');
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(onIssued).toHaveBeenCalledWith(expect.objectContaining({ status: 'issued', header: expect.objectContaining({ depositAmount: '5000.00' }), totals: expect.objectContaining({ total: '5000.00', cash: '5000.00' }) })), { timeout: 6000 });
  }, 30000);
});

describe('DocEditor: receipt in a non-VAT company (cash bill)', () => {
  it('shows the amount line editor (no category: the party is a customer) and issues a cash bill', async () => {
    setSettings({ companyKey: 'nonvat', role: 'operator' });
    const onIssued = ui(receipt);
    await userEvent.type(screen.getByRole('combobox', { name: 'ลูกค้า' }), 'ครัวริมคลอง{Enter}');
    const amount = await screen.findByRole('textbox', { name: 'จำนวนเงินรายการ 1' });
    await waitFor(() => expect(amount).toHaveValue('185.00')); // the customer's usual item landed (price and tax copied from the server)
    expect(screen.getByRole('combobox', { name: 'ภาษีรายการ 1' })).toHaveValue('EX');
    expect(screen.queryByRole('textbox', { name: 'หมวดค่าใช้จ่ายรายการ 1' })).toBeNull();
    await userEvent.clear(amount);
    await userEvent.type(amount, '1500');
    await userEvent.tab();
    expect(screen.getByRole('textbox', { name: 'จำนวนเงินรายการ 1' })).toHaveValue('1500.00');
    await waitFor(() => expect(totals()).toHaveTextContent('1,500.00'), { timeout: 4000 });
    await waitFor(() => expect(screen.getByRole('region', { name: 'ยังขาดอะไร' })).toHaveTextContent('ครบแล้ว'), { timeout: 12000 });
    await userEvent.keyboard('{Control>}{Enter}{/Control}');
    await screen.findByRole('alertdialog');
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(onIssued).toHaveBeenCalledWith(expect.objectContaining({ status: 'issued', totals: expect.objectContaining({ total: '1500.00', cash: '1500.00' }) })), { timeout: 6000 });
  }, 15000);
});

describe('DocEditor: payment voucher with withholding', () => {
  const extra = ['doc.PV.read', 'doc.PV.create', 'doc.PV.issue', 'doc.PB.read', 'doc.EX.read'];
  beforeEach(() => { PERMISSIONS_BY_ROLE.accountant.push(...extra); });
  afterEach(() => { for (const p of extra) PERMISSIONS_BY_ROLE.accountant.splice(PERMISSIONS_BY_ROLE.accountant.indexOf(p), 1); });

  it('category and WHT columns show for a vendor; 5,000.00 with SVC deduct => WHT 150.00, net payment 4,850.00 (server figures), and Deduct is the shown default', async () => {
    ui(voucher);
    await userEvent.type(screen.getByRole('combobox', { name: 'ผู้ขาย' }), 'ภูพาน{Enter}');
    expect(screen.getByRole('combobox', { name: 'ผู้รับภาระภาษีหัก ณ ที่จ่าย' })).toHaveValue('deduct');
    await userEvent.type(screen.getByRole('combobox', { name: 'รายการ 1' }), 'ค่าถ่ายภาพ');
    expect(screen.getByRole('textbox', { name: 'หมวดค่าใช้จ่ายรายการ 1' })).toBeVisible();
    const amount = screen.getByRole('textbox', { name: 'จำนวนเงินรายการ 1' });
    await userEvent.clear(amount);
    await userEvent.type(amount, '5000');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'ภาษีรายการ 1' }), 'EX');
    const wht = screen.getByRole('combobox', { name: 'หัก ณ ที่จ่ายรายการ 1' });
    await waitFor(() => expect(within(wht).getAllByRole('option').length).toBeGreaterThan(1)); // the server list arrived
    await userEvent.selectOptions(wht, 'SVC');
    await waitFor(() => expect(screen.getByText('ยอดชำระสุทธิ').nextElementSibling).toHaveTextContent('4,850.00'), { timeout: 4000 });
    expect(totals()).toHaveTextContent('150.00');
    expect(screen.getByRole('group', { name: 'ภาษีหัก ณ ที่จ่ายแยกตามประเภท' })).toHaveTextContent('ค่าบริการ 3% · ฐาน 5,000.00 · ภ.ง.ด.53');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'ผู้รับภาระภาษีหัก ณ ที่จ่าย' }), 'grossup_always');
    await waitFor(() => expect(screen.getByText('ยอดชำระสุทธิ').nextElementSibling).toHaveTextContent('5,000.00'), { timeout: 12000 });
    expect(totals()).toHaveTextContent('154.64');
  }, 15000);

  it('a voucher line defaults to the no-VAT code, and a WHT-types load error shows a retry in the column and blocks issuing (never silently "none")', async () => {
    let fail = true;
    testServer.use(http.get('*/bff/v1/wht-types', () => (fail
      ? HttpResponse.json({ status: 500, code: 'mock.server_error', title: 'โหลดไม่สำเร็จ' }, { status: 500, headers: { 'content-type': 'application/problem+json' } })
      : HttpResponse.json([{ code: 'SVC', nameTh: 'ค่าบริการ', rate: '3%', incomeType: '40(8)' }]))));
    ui(voucher);
    await userEvent.type(screen.getByRole('combobox', { name: 'ผู้ขาย' }), 'ภูพาน{Enter}');
    expect(screen.getByRole('combobox', { name: 'ภาษีรายการ 1' })).toHaveValue('EX');
    await userEvent.type(screen.getByRole('combobox', { name: 'รายการ 1' }), 'ค่าถ่ายภาพ');
    const amount = screen.getByRole('textbox', { name: 'จำนวนเงินรายการ 1' });
    await userEvent.clear(amount);
    await userEvent.type(amount, '5000');
    expect(await screen.findByRole('button', { name: 'ลองใหม่' })).toBeVisible();
    expect(screen.queryByRole('option', { name: 'ไม่หัก' })).toBeNull();
    await waitFor(() => expect(screen.getByRole('button', { name: 'บันทึกและออกใบสำคัญจ่าย' })).toBeDisabled());
    expect(screen.getByText(/โหลดประเภทภาษีหัก ณ ที่จ่ายไม่สำเร็จ/)).toBeVisible();
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: 'ลองใหม่' }));
    expect(await screen.findByRole('combobox', { name: 'หัก ณ ที่จ่ายรายการ 1' })).toBeVisible();
  }, 15000);
});
