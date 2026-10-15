import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import userEvent from '@testing-library/user-event';
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { endpoints } from '@/lib/api/endpoints';
import { qk } from '@/lib/query/keys';
import type { Me } from '@/domain/types';
import { testServer } from '@/mocks/test-server';
import { setSettings } from '@/mocks/settings';
import { resetState, saveState } from '@/mocks/store';
import { fixtureIds } from '@/mocks/fixtures/ids';
import { __setSearch } from '@/test/next-navigation';
import { ReportView } from './ReportView';

vi.mock('next/navigation', () => import('@/test/next-navigation'));
beforeAll(() => testServer.listen({ onUnhandledFrame: 'error' }));
afterAll(() => testServer.close());
afterEach(() => { testServer.resetHandlers(); vi.restoreAllMocks(); });
beforeEach(() => { localStorage.clear(); setSettings({ companyKey: 'vat', role: 'accountant', screenState: 'normal' }); resetState(); __setSearch(''); });
const ui = (defaults = { asOf: '2099-12-31' }) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const result = render(<QueryClientProvider client={qc}><ReportView kind="trial-balance" params={[{ key: 'asOf', kind: 'date', required: true, labelKey: 'reports.asOf' }]} defaults={defaults} /></QueryClientProvider>);
  return { ...result, qc };
};
it('does not query until required params are set', async () => {
  const spy = vi.spyOn(endpoints, 'getReport');
  const { qc } = ui({ asOf: '' });
  await waitFor(() => expect(qc.getQueryData(qk.me())).toBeDefined());
  expect(spy).not.toHaveBeenCalled();
  act(() => __setSearch('asOf=2099-12-31'));
  await waitFor(() => expect(spy).toHaveBeenCalled());
});
it('error shows ErrorState and never empty', async () => {
  vi.spyOn(endpoints, 'getReport').mockRejectedValue(new Error('offline'));
  const { container } = ui();
  await waitFor(() => expect(container.querySelector('[data-screen-state="error"]')).not.toBeNull());
  expect(container.querySelector('[data-screen-state="empty"]')).toBeNull();
});
it('corrupt journal shows amber tie-out banner naming both sides', async () => {
  const s = resetState();
  const j = s.journals.find((j) => j.docId === fixtureIds(s).tiIssuedUnpaid)!;
  j.preview.entries.flatMap((e) => e.lines).find((l) => l.accountCode === '1130')!.debit = '0.00';
  saveState(s);
  const { container } = ui();
  const banner = await screen.findByRole('status', { name: 'ยอดกระทบไม่ตรงกัน' });
  expect(banner).toHaveTextContent('เดบิต');
  expect(banner).toHaveTextContent('เครดิต');
  expect(banner.className).toContain('--color-status-pending-bg');
  expect(container.querySelector('[data-screen-state="locked"]')).toBeNull();
});
it('company switch drops previous company rows immediately', async () => {
  const s = resetState();
  s.accounts.find((a) => a.companyId === 'co-vat' && a.code === '1130')!.nameTh = 'VAT COMPANY ONLY';
  saveState(s);
  const { qc } = ui();
  await screen.findByText('VAT COMPANY ONLY');
  const me = qc.getQueryData<Me>(qk.me())!;
  setSettings({ companyKey: 'nonvat' });
  await act(async () => { qc.setQueryData(qk.me(), { ...me, activeCompanyId: 'co-nonvat', vatRegistered: false }); await new Promise((r) => setTimeout(r, 0)); });
  expect(screen.queryByText('VAT COMPANY ONLY')).toBeNull(); // at once: not after the new company's answer arrives
  await waitFor(() => expect(qc.getQueryData(qk.report('co-nonvat', 'trial-balance', { asOf: '2099-12-31' }))).toBeDefined());
  expect(screen.queryByText('VAT COMPANY ONLY')).toBeNull();
});
it('adopts a default that arrives late (the server business date lands after /me) and then queries', async () => {
  const spy = vi.spyOn(endpoints, 'getReport');
  const { qc, rerender } = ui({ asOf: '' });
  await waitFor(() => expect(qc.getQueryData(qk.me())).toBeDefined());
  expect(spy).not.toHaveBeenCalled();
  rerender(<QueryClientProvider client={qc}><ReportView kind="trial-balance" params={[{ key: 'asOf', kind: 'date', required: true, labelKey: 'reports.asOf' }]} defaults={{ asOf: '2099-12-31' }} /></QueryClientProvider>);
  await waitFor(() => expect(spy).toHaveBeenCalledWith('trial-balance', { asOf: '2099-12-31' }));
});
it('clearing a required param by hand reaches the needParams state and does not snap back to the default', async () => {
  const spy = vi.spyOn(endpoints, 'getReport');
  __setSearch('asOf=2099-12-31');
  ui({ asOf: '2099-12-30' });
  const date = await screen.findByLabelText(/ณ วันที่/);
  await waitFor(() => expect(date).toHaveValue('2099-12-31'));
  await userEvent.clear(date);
  expect(await screen.findByText('เลือกตัวเลือกที่จำเป็นให้ครบเพื่อดูรายงาน')).toBeVisible();
  await new Promise((r) => setTimeout(r, 500));
  expect(date).toHaveValue('');
  expect(spy).toHaveBeenCalledTimes(1);
});
it('the "tie-out matches" line is not shown under the empty state', async () => {
  ui({ asOf: '1900-01-01' });
  expect(await screen.findByText('ไม่มีรายการในช่วงที่เลือก')).toBeVisible();
  expect(screen.queryByText(/ยอดกระทบตรงกัน/)).toBeNull();
});
