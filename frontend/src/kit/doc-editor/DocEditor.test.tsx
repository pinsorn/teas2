import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http } from 'msw';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { taxInvoice } from '@/descriptors/tax-invoice';
import { setSettings } from '@/mocks/settings';
import { resetState } from '@/mocks/store';
import { testServer } from '@/mocks/test-server';
import { endpoints } from '@/lib/api/endpoints';
import { DocEditor } from './DocEditor';

vi.mock('next/navigation', () => import('@/test/next-navigation'));
const calls: string[] = [];
beforeAll(() => testServer.listen({ onUnhandledFrame: 'error' }));
afterEach(() => { testServer.resetHandlers(); testServer.events.removeAllListeners(); });
afterAll(() => testServer.close());
beforeEach(() => {
  localStorage.clear(); resetState(); calls.length = 0;
  setSettings({ companyKey: 'vat', role: 'accountant', screenState: 'normal' });
  testServer.events.on('request:start', ({ request }) => calls.push(`${request.method} ${new URL(request.url).pathname}`));
});

const ui = (onIssued = vi.fn()) => {
  render(<QueryClientProvider client={new QueryClient()}><DocEditor descriptor={taxInvoice} mode="create" onIssued={onIssued} /></QueryClientProvider>);
  return onIssued;
};

describe('DocEditor', () => {
  it('Enter picks the highlighted customer and prefills the usual item', async () => {
    ui();
    await userEvent.type(screen.getByRole('combobox', { name: 'ลูกค้า' }), 'นาวา');
    await userEvent.keyboard('{Enter}');
    expect(await screen.findByText(/0105568024684/)).toBeVisible();
    expect(screen.getByRole('textbox', { name: 'รายการ 1' })).toHaveValue('ออกแบบอัตลักษณ์องค์กร');
  });
  it('Enter while composing text does nothing', async () => {
    ui();
    const box = screen.getByRole('combobox', { name: 'ลูกค้า' });
    await userEvent.type(box, 'นาวา');
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: true }));
    expect(screen.queryByText(/0105568024684/)).toBeNull();
  });
  it('no match keeps the typed text and lists the gap in "ยังขาดอะไร"', async () => {
    ui();
    await userEvent.type(screen.getByRole('combobox', { name: 'ลูกค้า' }), 'ไม่มีชื่อนี้{Enter}');
    expect(screen.getByRole('combobox', { name: 'ลูกค้า' })).toHaveValue('ไม่มีชื่อนี้');
    expect(await screen.findByRole('region', { name: 'ยังขาดอะไร' })).toHaveTextContent('เลือกลูกค้า');
  });
  it('totals come from the compute endpoint, not the browser', async () => {
    ui();
    await userEvent.type(screen.getByRole('combobox', { name: 'ลูกค้า' }), 'นาวา{Enter}');
    await waitFor(() => expect(calls).toContain('POST /bff/v1/docs/TI/compute'));
    expect(screen.getByRole('region', { name: 'ยอดรวม' })).toHaveTextContent(/บาท/);
  });
  it('autosave creates one draft per editor session and updates it afterwards', async () => {
    ui();
    await userEvent.type(screen.getByRole('combobox', { name: 'ลูกค้า' }), 'นาวา{Enter}');
    await waitFor(() => expect(calls.filter((c) => c === 'POST /bff/v1/docs/TI')).toHaveLength(1), { timeout: 4000 });
    await userEvent.type(screen.getByRole('textbox', { name: 'หมายเหตุ' }), 'ส่งภายในวันศุกร์');
    await waitFor(() => expect(calls.some((c) => c.startsWith('PUT /bff/v1/docs/TI/'))).toBe(true), { timeout: 4000 });
    expect(calls.filter((c) => c === 'POST /bff/v1/docs/TI')).toHaveLength(1);
  });
  it('Ctrl+Enter opens the confirm dialog with totals; Enter issues', async () => {
    const onIssued = ui();
    await userEvent.type(screen.getByRole('combobox', { name: 'ลูกค้า' }), 'นาวา{Enter}');
    await waitFor(() => expect(screen.getByRole('region', { name: 'ยังขาดอะไร' })).toHaveTextContent('ครบแล้ว'));
    await userEvent.keyboard('{Control>}{Enter}{/Control}');
    expect(await screen.findByRole('alertdialog')).toHaveTextContent('รวมทั้งสิ้น');
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(onIssued).toHaveBeenCalledWith(expect.objectContaining({ status: 'issued' })));
  });
  it('a 409 on save tells the user and keeps their input', async () => {
    testServer.use(http.put('*/bff/v1/docs/TI/:id', () => new Response(JSON.stringify({ title: 'มีคนแก้เอกสารนี้ก่อนคุณ', code: 'doc.version_conflict', status: 409 }), { status: 409, headers: { 'content-type': 'application/problem+json' } })));
    ui();
    await userEvent.type(screen.getByRole('combobox', { name: 'ลูกค้า' }), 'นาวา{Enter}');
    await userEvent.type(screen.getByRole('textbox', { name: 'หมายเหตุ' }), 'x');
    expect(await screen.findByText('มีคนแก้เอกสารนี้ก่อนคุณ', {}, { timeout: 4000 })).toBeVisible();
    expect(screen.getByRole('textbox', { name: 'หมายเหตุ' })).toHaveValue('x');
  });

  it('a VAT customer without a tax id shows the server message and blocks issuing', async () => {
    ui();
    await userEvent.type(screen.getByRole('combobox', { name: 'ลูกค้า' }), 'สมบูรณ์{Enter}');
    expect(await screen.findByText('ผู้ซื้อจดทะเบียน VAT ต้องมีเลขผู้เสียภาษีและสาขา', {}, { timeout: 3000 })).toBeVisible();
    expect(screen.getByRole('button', { name: 'บันทึกและออกใบกำกับภาษี' })).toBeDisabled();
    await userEvent.keyboard('{Control>}{Enter}{/Control}');
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
  it('revise mode hands the proposal off instead of issuing', async () => {
    const issued = (await endpoints.listDocs('TI', { status: 'issued', limit: 1 })).items[0];
    const doc = await endpoints.getDoc('TI', issued.id);
    const onRevisionRequested = vi.fn();
    render(<QueryClientProvider client={new QueryClient()}><DocEditor descriptor={taxInvoice} mode="revise" initial={doc} onIssued={vi.fn()} onRevisionRequested={onRevisionRequested} /></QueryClientProvider>);
    const save = await screen.findByRole('button', { name: 'บันทึกการแก้ไข' });
    await waitFor(() => expect(save).toBeEnabled(), { timeout: 3000 });
    await userEvent.click(save);
    expect(onRevisionRequested).toHaveBeenCalledWith(expect.objectContaining({ header: expect.objectContaining({ partyId: doc.header.partyId }), lines: expect.any(Array) }));
    expect(calls.filter((c) => c.startsWith('POST /bff/v1/docs/TI/') && c.endsWith('/issue') || c.startsWith('PUT'))).toHaveLength(0);
  });
});
