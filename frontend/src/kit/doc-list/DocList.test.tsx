import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpResponse, http } from 'msw';
import { qk } from '@/lib/query/keys';
import type { Me } from '@/domain/types';
import { __setSearch, useRouter } from '@/test/next-navigation';
import { setSettings } from '@/mocks/settings';
import { resetState } from '@/mocks/store';
import { testServer } from '@/mocks/test-server';
import { taxInvoice } from '@/descriptors/tax-invoice';
import type { BulkAction } from './BulkBar';
import { DocList } from './DocList';

vi.mock('next/navigation', () => import('@/test/next-navigation'));
beforeAll(() => testServer.listen({ onUnhandledFrame: 'error' }));
afterEach(() => testServer.resetHandlers());
afterAll(() => testServer.close());
beforeEach(() => { __setSearch(''); localStorage.clear(); resetState(); setSettings({ companyKey: 'vat', role: 'accountant', screenState: 'normal' }); });

const ui = (bulkActions: BulkAction[] = [], qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })) => render(
  <QueryClientProvider client={qc}>
    <DocList descriptor={taxInvoice} columns={[{ key: 'number', header: 'เลขที่', cell: (r) => r.number ?? 'ร่าง' }]}
      savedViews={[{ key: 'overdue', label: 'เกินกำหนด', params: { status: 'issued', overdue: '1' } }]} bulkActions={bulkActions} />
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
  it('forbidden list names the missing permission itself', async () => {
    testServer.use(http.get('*/bff/v1/docs/:type', () => HttpResponse.json(
      { status: 403, code: 'auth.forbidden', title: 'ห้าม', detail: 'ต้องมีสิทธิ์ doc.TI.read' }, { status: 403 })));
    ui();
    expect(await screen.findByText(/doc\.TI\.read/)).toBeVisible();
  });
  it('a failed /me is forbidden without claiming the list permission is missing', async () => {
    setSettings({ screenState: 'forbidden' });
    ui();
    expect(await screen.findByText(/ไม่มีสิทธิ์/)).toBeVisible();
    expect(screen.queryByText(/doc\.TI\.read/)).toBeNull();
  });
  it('row checkboxes have unique names and the header shows a partial selection', async () => {
    ui();
    const rows = await screen.findAllByRole('row');
    const names = within(rows[1]).getAllByRole('checkbox').map((c) => c.getAttribute('aria-label'));
    const second = within(rows[2]).getByRole('checkbox').getAttribute('aria-label');
    expect(names[0]).toMatch(/^เลือก /);
    expect(names[0]).not.toBe(second);
    await userEvent.click(within(rows[1]).getByRole('checkbox'));
    expect(screen.getByRole('checkbox', { name: 'เลือกทั้งหมดในหน้านี้' })).toHaveAttribute('aria-checked', 'mixed');
  });
  it('a company switch empties the selection (never bulk-act on another company\'s ids)', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    ui([], qc);
    const rows = await screen.findAllByRole('row');
    await userEvent.click(within(rows[1]).getByRole('checkbox'));
    expect(screen.getByText('เลือก 1 รายการ')).toBeVisible();
    const me = qc.getQueryData<Me>(qk.me())!;
    act(() => { qc.setQueryData(qk.me(), { ...me, activeCompanyId: 'co-other' }); });
    await screen.findAllByRole('row');
    await waitFor(() => expect(screen.queryByText(/^เลือก \d+ รายการ$/)).toBeNull());
    act(() => { qc.setQueryData(qk.me(), me); });
    await screen.findAllByRole('row');
    expect(screen.queryByText(/^เลือก \d+ รายการ$/)).toBeNull();
  });
  it('a saved view keeps the client-side overdue param (round trip)', async () => {
    __setSearch('status=issued&overdue=1&view=overdue');
    ui();
    await screen.findByRole('searchbox');
    await userEvent.click(screen.getByRole('button', { name: 'บันทึกมุมมองนี้' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'ชื่อมุมมอง' }), 'ของฉัน{Enter}');
    const saved = JSON.parse(localStorage.getItem('teas2.views.TI')!);
    expect(saved[0].params).toEqual({ status: 'issued', overdue: '1' });
    await userEvent.click(screen.getByRole('button', { name: 'ของฉัน' }));
    expect(vi.mocked(useRouter().replace).mock.lastCall![0]).toContain('overdue=1');
  });
  it('a successful bulk run calls the action with the selected ids and clears the selection', async () => {
    const run = vi.fn(async () => {});
    ui([{ key: 'x', label: 'ทำรายการ', permission: 'doc.TI.read', run }]);
    const rows = await screen.findAllByRole('row');
    await userEvent.click(within(rows[1]).getByRole('checkbox'));
    await userEvent.click(screen.getByRole('button', { name: 'ทำรายการ' }));
    await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    expect(run.mock.calls[0]).toHaveLength(1);
    await waitFor(() => expect(screen.queryByText('เลือก 1 รายการ')).toBeNull());
  });
});
