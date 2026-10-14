import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { useState } from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HeaderFieldKey } from '@/domain/descriptors';
import type { DocHeader, DocTotals, WhtLine } from '@/domain/types';
import { setSettings } from '@/mocks/settings';
import { resetState } from '@/mocks/store';
import { testServer } from '@/mocks/test-server';
import { HeaderFields } from './HeaderFields';
import { TotalsPanel } from './TotalsPanel';

vi.mock('next/navigation', () => import('@/test/next-navigation'));
beforeAll(() => testServer.listen({ onUnhandledFrame: 'error' }));
afterEach(() => { cleanup(); testServer.resetHandlers(); });
afterAll(() => testServer.close());
beforeEach(() => { localStorage.clear(); resetState(); setSettings({ companyKey: 'vat', role: 'accountant', screenState: 'normal' }); });

function Host({ keys, initial = { documentDate: '2026-10-14' }, spy }: { keys: HeaderFieldKey[]; initial?: DocHeader; spy?: (h: DocHeader) => void }) {
  const [h, setH] = useState<DocHeader>(initial);
  const [qc] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false } } }));
  spy?.(h);
  return <QueryClientProvider client={qc}><HeaderFields keys={keys} ids="x" header={h} setHeader={setH} /></QueryClientProvider>;
}

describe('HeaderFields payment fields', () => {
  it('bank account: the company accounts from the server, the default shown before any choice, a choice lands in the header', async () => {
    const seen = vi.fn();
    render(<Host keys={['bankAccount']} spy={seen} />);
    const select = await screen.findByRole('combobox', { name: 'บัญชีรับ/จ่ายเงิน' });
    await waitFor(() => expect(within(select).getAllByRole('option')).toHaveLength(3));
    expect(select).toHaveValue('ba-kbank'); // the server default, filled in by the engine when the header leaves it out
    await userEvent.selectOptions(select, 'ba-scb');
    expect(seen).toHaveBeenLastCalledWith(expect.objectContaining({ bankAccountId: 'ba-scb' }));
  });
  it('bank account list failing says so instead of showing an empty select', async () => {
    testServer.use(http.get('*/bff/v1/bank-accounts', () => HttpResponse.json({ status: 500, code: 'x', title: 'x' }, { status: 500, headers: { 'content-type': 'application/problem+json' } })));
    render(<Host keys={['bankAccount']} />);
    expect(await screen.findByRole('option', { name: 'โหลดรายการบัญชีไม่สำเร็จ' })).toBeInTheDocument();
  });
  it('payment method defaults to transfer; cheque details appear only for a cheque and clear when emptied', async () => {
    const seen = vi.fn();
    render(<Host keys={['paymentMethod', 'cheque']} spy={seen} />);
    const method = screen.getByRole('combobox', { name: 'วิธีชำระเงิน' });
    expect(method).toHaveValue('transfer');
    expect(screen.queryByRole('textbox', { name: 'เลขที่เช็ค' })).toBeNull();
    await userEvent.selectOptions(method, 'cheque');
    await userEvent.type(screen.getByRole('textbox', { name: 'เลขที่เช็ค' }), '0012345');
    await userEvent.type(screen.getByRole('textbox', { name: 'ธนาคารที่ออกเช็ค' }), 'กสิกรไทย');
    expect(seen).toHaveBeenLastCalledWith(expect.objectContaining({ paymentMethod: 'cheque', cheque: { number: '0012345', date: '', bank: 'กสิกรไทย' } }));
    await userEvent.clear(screen.getByRole('textbox', { name: 'เลขที่เช็ค' }));
    await userEvent.clear(screen.getByRole('textbox', { name: 'ธนาคารที่ออกเช็ค' }));
    expect(seen.mock.lastCall![0].cheque).toBeUndefined();
  });
  it('WHT mode: deduct is shown before a choice; the three modes are offered', async () => {
    const seen = vi.fn();
    render(<Host keys={['whtMode']} spy={seen} />);
    const mode = screen.getByRole('combobox', { name: 'ผู้รับภาระภาษีหัก ณ ที่จ่าย' });
    expect(mode).toHaveValue('deduct');
    expect(within(mode).getAllByRole('option')).toHaveLength(3);
    await userEvent.selectOptions(mode, 'grossup_always');
    expect(seen).toHaveBeenLastCalledWith(expect.objectContaining({ whtMode: 'grossup_always' }));
  });
});

const totals = (p: Partial<DocTotals>): DocTotals => ({ gross: '5000.00', discount: '0.00', net: '5000.00', vat: '0.00', total: '5000.00', amountInWords: 'ห้าพันบาทถ้วน', ...p });
const line = (p: Partial<WhtLine>): WhtLine => ({ code: 'SVC', nameTh: 'ค่าบริการ', form: 'PND53', base: '5000.00', rate: '3%', tax: '150.00', income: '5000.00', ...p });

describe('TotalsPanel with WhtSummary (server figures only)', () => {
  it('shows the withholding tax by type with its return and the net payment, all copied from the server', () => {
    render(<TotalsPanel totals={totals({ wht: '150.00', cash: '4850.00' })} whtLines={[line({}), line({ code: 'RENT', nameTh: 'ค่าเช่า', rate: '5%', base: '2000.00', tax: '100.00', form: 'PND3' })]} pending={false} onRetry={() => undefined} />);
    expect(screen.getByText('หัก ณ ที่จ่าย')).toBeVisible();
    const g = screen.getByRole('group', { name: 'ภาษีหัก ณ ที่จ่ายแยกตามประเภท' });
    expect(g).toHaveTextContent('ค่าบริการ 3% · ฐาน 5,000.00 · ภ.ง.ด.53');
    expect(g).toHaveTextContent('ค่าเช่า 5% · ฐาน 2,000.00 · ภ.ง.ด.3');
    expect(screen.getByText('ยอดชำระสุทธิ').nextElementSibling).toHaveTextContent('4,850.00');
    expect(screen.getAllByText('150.00').length).toBeGreaterThan(0); // never 250.00: the browser does not sum the lines
    expect(screen.queryByText('250.00')).toBeNull();
  });
  it('a tax invoice (no cash) keeps the plain withholding row and shows no net-payment line', () => {
    render(<TotalsPanel totals={totals({ wht: '30.00' })} pending={false} onRetry={() => undefined} />);
    expect(screen.getByText('หักภาษี ณ ที่จ่าย')).toBeVisible();
    expect(screen.queryByText('ยอดชำระสุทธิ')).toBeNull();
  });
});
