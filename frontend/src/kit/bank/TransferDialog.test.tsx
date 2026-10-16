import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BankLine } from '@/domain/types';
import { setSettings } from '@/mocks/settings';
import { loadState, resetState } from '@/mocks/store';
import { testServer } from '@/mocks/test-server';
import { TransferDialog } from './TransferDialog';

vi.mock('next/navigation', () => import('@/test/next-navigation'));
beforeAll(() => testServer.listen({ onUnhandledFrame: 'error' }));
afterEach(() => { cleanup(); testServer.resetHandlers(); });
afterAll(() => testServer.close());
beforeEach(() => { localStorage.clear(); resetState(); setSettings({ companyKey: 'vat', role: 'accountant', screenState: 'normal' }); });

const lineOf = (id: string): BankLine => { const { companyId, ...l } = loadState().bankLines.find((x) => x.id === id)!; void companyId; return l; };

describe('TransferDialog', () => {
  it('offers the other accounts of the company (not this one), books one transfer journal and closes', async () => {
    const onClose = vi.fn();
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><TransferDialog line={lineOf('bi-001-001')} accountId="ba-kbank" onClose={onClose} /></QueryClientProvider>);
    const select = await screen.findByRole('combobox', { name: 'บัญชีอีกฝั่ง' });
    await waitFor(() => expect(select.querySelector('option[value="ba-scb"]')).not.toBeNull());
    expect(select.querySelector('option[value="ba-kbank"]')).toBeNull();
    await userEvent.selectOptions(select, 'ba-scb');
    await userEvent.click(screen.getByRole('button', { name: 'โอน' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const st = loadState();
    expect(st.bankLines.find((x) => x.id === 'bi-001-001')!.status).toBe('matched');
    expect(st.bankJournals.filter((j) => j.kind === 'transfer')).toHaveLength(1);
  });
});
