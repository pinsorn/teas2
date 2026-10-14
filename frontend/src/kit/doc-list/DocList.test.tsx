import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setSettings } from '@/mocks/settings';
import { resetState } from '@/mocks/store';
import { testServer } from '@/mocks/test-server';
import { taxInvoice } from '@/descriptors/tax-invoice';
import { DocList } from './DocList';

vi.mock('next/navigation', () => import('@/test/next-navigation'));
beforeAll(() => testServer.listen({ onUnhandledFrame: 'error' }));
afterEach(() => testServer.resetHandlers());
afterAll(() => testServer.close());
beforeEach(() => { localStorage.clear(); resetState(); setSettings({ companyKey: 'vat', role: 'accountant', screenState: 'normal' }); });

const ui = () => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <DocList descriptor={taxInvoice} columns={[{ key: 'number', header: 'เลขที่', cell: (r) => r.number ?? 'ร่าง' }]}
      savedViews={[{ key: 'overdue', label: 'เกินกำหนด', params: { status: 'issued', overdue: '1' } }]} bulkActions={[]} />
  </QueryClientProvider>);

describe('DocList', () => {
  it('shows rows from the server', async () => {
    ui();
    expect(await screen.findAllByRole('row')).not.toHaveLength(0);
  });
  it('an error is an error state, never "no data" (TEAS 1 XC-01)', async () => {
    setSettings({ screenState: 'error' });
    ui();
    expect(await screen.findByRole('alert')).toHaveTextContent('ระบบขัดข้องชั่วคราว');
    expect(screen.queryByText(/ยังไม่มี/)).toBeNull();
    expect(screen.getByRole('button', { name: 'ลองใหม่' })).toBeVisible();
  });
  it('forbidden names the permission', async () => {
    setSettings({ screenState: 'forbidden' });
    ui();
    expect(await screen.findByText(/ไม่มีสิทธิ์/)).toBeVisible();
  });
  it('empty state offers the next step', async () => {
    setSettings({ screenState: 'empty' });
    ui();
    expect(await screen.findByRole('link', { name: /สร้างใบกำกับภาษี/ })).toBeVisible();
  });
  it('"/" focuses search', async () => {
    ui();
    await screen.findAllByRole('row');
    await userEvent.keyboard('/');
    expect(screen.getByRole('searchbox')).toHaveFocus();
  });
  it('selecting rows shows the bulk bar with the count', async () => {
    ui();
    const rows = await screen.findAllByRole('row');
    await userEvent.click(within(rows[1]).getByRole('checkbox'));
    expect(screen.getByText('เลือก 1 รายการ')).toBeVisible();
  });
  it('pages 25 rows with "โหลดเพิ่ม"', async () => {
    ui();
    await screen.findAllByRole('row');
    expect(screen.getAllByRole('row')).toHaveLength(26);
    await userEvent.click(screen.getByRole('button', { name: 'โหลดเพิ่ม' }));
    expect((await screen.findAllByRole('row')).length).toBeGreaterThan(26);
  });
  it('no such document type for a non-VAT company is "not available", not empty', async () => {
    setSettings({ companyKey: 'nonvat' });
    ui();
    expect(await screen.findByText('ใช้ได้เฉพาะบริษัทที่จดทะเบียน VAT')).toBeVisible();
  });
});
