import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BankLine } from '@/domain/types';
import { setSettings } from '@/mocks/settings';
import { loadState, resetState } from '@/mocks/store';
import { testServer } from '@/mocks/test-server';
import { InlineJournalDialog } from './InlineJournalDialog';

vi.mock('next/navigation', () => import('@/test/next-navigation'));
beforeAll(() => testServer.listen({ onUnhandledFrame: 'error' }));
afterEach(() => { cleanup(); testServer.resetHandlers(); });
afterAll(() => testServer.close());
beforeEach(() => { localStorage.clear(); resetState(); setSettings({ companyKey: 'vat', role: 'accountant', screenState: 'normal' }); });

const lineOf = (id: string): BankLine => { const { companyId, ...l } = loadState().bankLines.find((x) => x.id === id)!; void companyId; return l; };
const mount = (id = 'bi-001-017') => {
  const onClose = vi.fn();
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><InlineJournalDialog line={lineOf(id)} bankAccountCode="1121" onClose={onClose} /></QueryClientProvider>);
  return onClose;
};
const choose = async (code: string) => {
  const select = await screen.findByRole('combobox', { name: /บัญชีที่จ่าย|บัญชีที่รับ/ });
  await waitFor(() => expect(select.querySelector(`option[value="${code}"]`)).not.toBeNull()); // the account list arrives after the dialog opens
  await userEvent.selectOptions(select, code);
};

describe('InlineJournalDialog', () => {
  it('books the fee line to an expense account, dated at the line, and closes', async () => {
    const onClose = mount();
    await choose('5200');
    await userEvent.click(screen.getByRole('button', { name: 'บันทึกบัญชี' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const st = loadState(), l = st.bankLines.find((x) => x.id === 'bi-001-017')!;
    expect(l.status).toBe('posted');
    expect(st.bankJournals.find((j) => j.id === l.journalId)!.entries[0]).toMatchObject({ date: '2026-09-30', kind: 'original' });
  });

  it('offers no VAT / withholding control account and not the bank itself', async () => {
    mount();
    const select = await screen.findByRole('combobox', { name: /บัญชีที่จ่าย|บัญชีที่รับ/ });
    await waitFor(() => expect(select.querySelectorAll('option').length).toBeGreaterThan(10));
    const codes = [...select.querySelectorAll('option')].map((o) => o.getAttribute('value'));
    for (const hidden of ['1170', '2151', '1180', '2131', '2152', '1121', '']) expect(codes.includes(hidden) && hidden !== '').toBe(false);
    expect(codes).toContain('5200');
  });

  it('offers no receivable / payable, deposit, payroll, cash / bank or equity account either (I1)', async () => {
    mount('bi-001-018');
    const select = await screen.findByRole('combobox', { name: /บัญชีที่จ่าย|บัญชีที่รับ/ });
    await waitFor(() => expect(select.querySelectorAll('option').length).toBeGreaterThan(10));
    const codes = [...select.querySelectorAll('option')].map((o) => o.getAttribute('value'));
    for (const hidden of ['1130', '2110', '2180', '2140', '1140', '1171', '2153', '2160', '1122', '1110', '3200', '3900']) expect(codes).not.toContain(hidden);
    expect(screen.queryByLabelText('คู่ค้า')).toBeNull();
  });
});
