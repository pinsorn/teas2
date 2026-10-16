import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BankLine } from '@/domain/types';
import { setSettings } from '@/mocks/settings';
import { loadState, resetState, saveState } from '@/mocks/store';
import { testServer } from '@/mocks/test-server';
import { MatchPanel } from './MatchPanel';

vi.mock('next/navigation', () => import('@/test/next-navigation'));
beforeAll(() => testServer.listen({ onUnhandledFrame: 'error' }));
afterEach(() => { cleanup(); testServer.resetHandlers(); });
afterAll(() => testServer.close());
beforeEach(() => { localStorage.clear(); resetState(); setSettings({ companyKey: 'vat', role: 'accountant', screenState: 'normal' }); });

const lineOf = (id: string): BankLine => { const { companyId, ...l } = loadState().bankLines.find((x) => x.id === id)!; void companyId; return l; };
const mount = (id = 'bi-001-003') => {
  const onClose = vi.fn();
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MatchPanel line={lineOf(id)} onClose={onClose} /></QueryClientProvider>);
  return onClose;
};

describe('MatchPanel', () => {
  it('shows the one suggestion (same cash, same account, within 7 days) and matching it closes the panel with the line matched', async () => {
    const onClose = mount();
    const dialog = await screen.findByRole('dialog', { name: 'ค้นหารายการที่ตรงกัน' });
    const list = await within(dialog).findByRole('list', { name: 'เอกสารที่จับคู่ได้' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);
    expect(list).toHaveTextContent('RC-202609-0001');
    expect(list).toHaveTextContent('ยอดตรงกัน');
    const submit = within(dialog).getByRole('button', { name: 'จับคู่' });
    expect(submit).toBeDisabled(); // nothing picked yet
    await userEvent.click(within(list).getByRole('checkbox', { name: 'RC-202609-0001' }));
    await userEvent.click(submit);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(loadState().bankLines.find((l) => l.id === 'bi-001-003')).toMatchObject({ status: 'matched', matchedDocIds: ['rc-013'] });
  });

  it('a search widens to other receipts of the account; a wrong pick is refused with both sides of the sum and nothing is matched', async () => {
    const onClose = mount();
    await screen.findByRole('list', { name: 'เอกสารที่จับคู่ได้' });
    await userEvent.type(screen.getByLabelText('ค้นหาเลขที่เอกสารหรือชื่อคู่ค้า'), 'RC-202609-0002');
    const item = await screen.findByRole('checkbox', { name: 'RC-202609-0002' });
    await userEvent.click(item);
    await userEvent.click(screen.getByRole('button', { name: 'จับคู่' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('64,200.00');
    expect(alert).toHaveTextContent('6,955.00');
    expect(onClose).not.toHaveBeenCalled();
    expect(loadState().bankLines.find((l) => l.id === 'bi-001-003')!.status).toBe('unmatched');
  });

  it('a bank fee difference: the fee amount is typed positive, sent negative, and its journal is written', async () => {
    const st = loadState();
    st.bankLines.find((l) => l.id === 'bi-001-003')!.amount = '6930.00'; // the bank took 25.00 off
    saveState(st);
    const onClose = mount();
    await userEvent.type(await screen.findByLabelText('ค้นหาเลขที่เอกสารหรือชื่อคู่ค้า'), 'RC-202609-0001');
    await userEvent.click(await screen.findByRole('checkbox', { name: 'RC-202609-0001' }));
    await userEvent.selectOptions(screen.getByLabelText('ผลต่าง'), 'BankFee');
    await userEvent.type(screen.getByLabelText('จำนวนเงินผลต่าง (บาท)'), '25.00');
    await userEvent.click(screen.getByRole('button', { name: 'จับคู่' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const after = loadState();
    expect(after.bankLines.find((l) => l.id === 'bi-001-003')!.diff).toMatchObject({ role: 'BankFee', amount: '-25.00' });
    expect(after.bankJournals.at(-1)).toMatchObject({ kind: 'fee', label: 'ค่าธรรมเนียมจากการกระทบยอด' });
  });

  it('a split share is typed for one document and stored as that document\'s share', async () => {
    const st = loadState();
    st.bankLines.find((l) => l.id === 'bi-001-003')!.amount = '3000.00';
    saveState(st);
    const onClose = mount();
    await userEvent.type(await screen.findByLabelText('ค้นหาเลขที่เอกสารหรือชื่อคู่ค้า'), 'RC-202609-0001');
    await userEvent.click(await screen.findByRole('checkbox', { name: 'RC-202609-0001' }));
    await userEvent.type(screen.getByLabelText(/ยอดที่จับคู่กับรายการนี้/), '3000.00');
    await userEvent.click(screen.getByRole('button', { name: 'จับคู่' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(loadState().bankLines.find((l) => l.id === 'bi-001-003')!.matches).toMatchObject([{ docId: 'rc-013', amount: '3000.00', docCash: '6955.00' }]);
  });

  it('a payment line is offered vouchers, not receipts; no suggestion says so', async () => {
    mount('bi-001-001'); // -35,000.00: no voucher has that cash
    expect(await screen.findByTestId('no-candidates')).toHaveTextContent('ไม่พบรายการแนะนำ');
  });
});
