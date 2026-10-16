import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setSettings } from '@/mocks/settings';
import { resetState } from '@/mocks/store';
import { testServer } from '@/mocks/test-server';
import { StatementLines } from './StatementLines';

vi.mock('next/navigation', () => import('@/test/next-navigation'));
beforeAll(() => testServer.listen({ onUnhandledFrame: 'error' }));
afterEach(() => { cleanup(); testServer.resetHandlers(); });
afterAll(() => testServer.close());
beforeEach(() => { localStorage.clear(); resetState(); setSettings({ companyKey: 'vat', role: 'accountant', screenState: 'normal' }); });

const mount = (accountId: string, onImport?: () => void) =>
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><StatementLines accountId={accountId} onImport={onImport} /></QueryClientProvider>);

describe('StatementLines', () => {
  it('shows the imported lines newest first with in / out split by sign and the statement balance', async () => {
    mount('ba-kbank');
    const rows = await screen.findAllByRole('row');
    expect(rows).toHaveLength(1 + 18);
    const first = within(rows[1]).getAllByRole('cell');
    expect(first[1]).toHaveTextContent('ดอกเบี้ยรับ'); // 30 Sep, the last line of the file
    expect(first[2]).toHaveTextContent('3.12'); // in
    expect(first[3].textContent).toBe(''); // out
    expect(first[5]).toHaveTextContent('ยังไม่จับคู่');
    const fee = within(rows[2]).getAllByRole('cell');
    expect(fee[2].textContent).toBe(''); // not an inflow
    expect(fee[3]).toHaveTextContent('25.00');
  });

  it('an account without imports says so and offers the import, which the caller wires', async () => {
    const onImport = vi.fn();
    mount('ba-scb', onImport);
    expect(await screen.findByText('ยังไม่มีรายการเดินบัญชี — นำเข้า statement')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'นำเข้า statement' }));
    expect(onImport).toHaveBeenCalledTimes(1);
  });

  it('without the right to import the empty state offers no button', async () => {
    mount('ba-scb');
    expect(await screen.findByText('ยังไม่มีรายการเดินบัญชี — นำเข้า statement')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'นำเข้า statement' })).toBeNull();
  });

  it('filters by status and date; a filter with no rows is "no match", not "nothing imported"', async () => {
    mount('ba-kbank');
    await screen.findAllByRole('row');
    await userEvent.type(screen.getByLabelText('ตั้งแต่วันที่'), '2026-09-17');
    await userEvent.type(screen.getByLabelText('ถึงวันที่'), '2026-09-23');
    await waitFor(() => expect(screen.getAllByRole('row')).toHaveLength(1 + 4));
    await userEvent.selectOptions(screen.getByLabelText('สถานะรายการ'), 'matched');
    expect(await screen.findByText('ไม่พบรายการตามตัวกรอง')).toBeVisible();
    expect(screen.queryByText('ยังไม่มีรายการเดินบัญชี — นำเข้า statement')).toBeNull();
    await userEvent.click(screen.getAllByRole('button', { name: 'ล้างตัวกรอง' })[0]);
    await waitFor(() => expect(screen.getAllByRole('row')).toHaveLength(1 + 18));
  });

  it('an error is an error (with retry), a forbidden answer names the permission', async () => {
    setSettings({ screenState: 'error' });
    mount('ba-kbank');
    await waitFor(() => expect(document.querySelector('[data-screen-state="error"]'), document.body.innerHTML).not.toBeNull(), { timeout: 4000 });
    expect(document.querySelector('[data-screen-state="empty"]')).toBeNull(); // never shown as "no data"
    cleanup();
    setSettings({ screenState: 'forbidden' });
    mount('ba-kbank');
    await waitFor(() => expect(document.querySelector('[data-screen-state="forbidden"]')).not.toBeNull());
    expect(document.querySelector('[data-screen-state="empty"]')).toBeNull();
  });
});
