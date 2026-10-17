import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { setSettings } from '@/mocks/settings';
import { resetState } from '@/mocks/store';
import { testServer } from '@/mocks/test-server';
import { __setSearch } from '@/test/next-navigation';
import { FilingView } from './FilingView';

vi.mock('next/navigation', () => import('@/test/next-navigation'));
beforeAll(() => testServer.listen({ onUnhandledFrame: 'error' }));
afterAll(() => testServer.close());
afterEach(() => { testServer.resetHandlers(); vi.restoreAllMocks(); });
beforeEach(() => { localStorage.clear(); setSettings({ companyKey: 'vat', role: 'accountant', screenState: 'normal' }); resetState(); __setSearch(''); });
const ui = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><FilingView form="PP30" periodKind="month" /></QueryClientProvider>);
};

it('a month with blockers disables finalize and names the first blocker, with a link to fix it', async () => {
  __setSearch('period=2026-10');
  ui();
  const btn = await screen.findByRole('button', { name: /ยืนยันยื่นแบบ/ });
  expect((btn as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByTestId('finalize-why')).toHaveTextContent('ยืนยันไม่ได้:');
  expect(screen.getByTestId('finalize-why')).toHaveTextContent('ฉบับร่าง');
  expect(screen.getByTestId('blockers').querySelector('a')?.getAttribute('href')).toMatch(/\/edit$/);
});

it('a finalizable month confirms through the dialog (totals shown), then reads as filed with the read-only banner and the RD Prep file', async () => {
  __setSearch('period=2026-09');
  ui();
  const btn = await screen.findByRole('button', { name: /ยืนยันยื่นแบบ/ });
  expect((btn as HTMLButtonElement).disabled).toBe(false);
  await userEvent.click(btn);
  const dialog = await screen.findByRole('alertdialog');
  expect(dialog).toHaveTextContent('แก้ไขตัวเลขไม่ได้');
  expect(dialog).toHaveTextContent('ภาษีขาย (ช่อง 5)');
  await userEvent.click(within(dialog).getByRole('button', { name: /ยืนยันยื่นแบบ/ }));
  expect(await screen.findByTestId('filed-banner')).toHaveTextContent('ยื่นแล้ว');
  expect(screen.getByRole('button', { name: /RD Prep/ })).toBeTruthy();
  expect(screen.queryByRole('button', { name: /ยืนยันยื่นแบบ/ })).toBeNull();
});

it('an operator is forbidden; a server error is an error, never "empty"; the toolbar empty state is empty, never an error', async () => {
  setSettings({ role: 'operator' });
  const a = ui();
  await waitFor(() => expect(a.container.querySelector('[data-screen-state="forbidden"]')).not.toBeNull());
  a.unmount();
  setSettings({ role: 'accountant', screenState: 'error' });
  const b = ui();
  await waitFor(() => expect(b.container.querySelector('[data-screen-state="error"]')).not.toBeNull());
  expect(b.container.querySelector('[data-screen-state="empty"]')).toBeNull();
  b.unmount();
  setSettings({ screenState: 'empty' });
  __setSearch('period=2026-09');
  const c = ui();
  await waitFor(() => expect(c.container.querySelector('[data-screen-state="empty"]')).not.toBeNull());
  expect(c.container.querySelector('[data-screen-state="error"]')).toBeNull();
});

it('a company outside VAT has no ภ.พ.30', async () => {
  setSettings({ companyKey: 'nonvat' });
  const { container } = ui();
  await waitFor(() => expect(container.querySelector('[data-screen-state="not-available"]')).not.toBeNull());
});
