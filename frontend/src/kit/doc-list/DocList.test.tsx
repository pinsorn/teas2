import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpResponse, http } from 'msw';
import { ApiError } from '@/lib/api/client';
import { routesOf } from '@/domain/descriptors';
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
    testServer.use(http.get('*/bff/v1/me', () => HttpResponse.json({ type: 'about:blank', status: 403, code: 'auth.forbidden', title: 'คุณไม่มีสิทธิ์ดูข้อมูลนี้', traceId: 't' }, { status: 403 })));
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
    await userEvent.keyboard('[Slash]');
    expect(screen.getByRole('searchbox')).toHaveFocus();
  });
  it('the page has one h1 with the type title', async () => {
    ui();
    expect(await screen.findByRole('heading', { level: 1, name: 'ใบกำกับภาษี' })).toBeVisible();
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
  it('a 403 from /me itself is forbidden without claiming the list permission is missing', async () => {
    testServer.use(http.get('*/bff/v1/me', () => HttpResponse.json({ type: 'about:blank', status: 403, code: 'auth.forbidden', title: 'คุณไม่มีสิทธิ์ดูข้อมูลนี้', traceId: 't' }, { status: 403 })));
    ui();
    expect(await screen.findByText(/ไม่มีสิทธิ์/)).toBeVisible();
    expect(screen.queryByText(/doc\.TI\.read/)).toBeNull();
  });
  it('toolbar screen state "forbidden": /me succeeds, the list 403 renders the forbidden state (not an error, not empty)', async () => {
    setSettings({ screenState: 'forbidden' });
    const { container } = ui();
    await waitFor(() => expect(container.querySelector('[data-screen-state="forbidden"]')).not.toBeNull());
    expect(container.querySelector('[data-screen-state="error"]')).toBeNull();
    expect(container.querySelector('[data-screen-state="empty"]')).toBeNull();
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
  it('I8: a failed refetch of an empty list shows only the error, and its retry refetches', async () => {
    let mode: 'empty' | 'fail' | 'rows' = 'empty';
    testServer.use(http.get('*/bff/v1/docs/:type', () => mode === 'fail'
      ? HttpResponse.json({ status: 500, code: 'x', title: 'ล้มเหลว' }, { status: 500 })
      : HttpResponse.json(mode === 'empty' ? { items: [] } : { items: [{ id: 'd1', type: taxInvoice.type, number: 'TI-X1', status: 'issued', documentDate: '2026-10-01', partyName: 'ก', total: '1.00', createdByAgent: false }] })));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    ui([], qc);
    expect(await screen.findByText(/ยังไม่มี/)).toBeVisible();
    mode = 'fail';
    await act(async () => { await qc.refetchQueries({ predicate: (q) => q.queryKey.includes('docs') }).catch(() => undefined); });
    expect(await screen.findByRole('alert')).toHaveTextContent('ล้มเหลว');
    expect(screen.queryByText(/ยังไม่มี/)).toBeNull(); // empty + error never together
    mode = 'rows';
    await userEvent.click(screen.getByRole('button', { name: 'ลองใหม่' }));
    expect(await screen.findByText('TI-X1')).toBeVisible();
  });
  it('I5: the outstanding filter goes to the server', async () => {
    const seen: string[] = [];
    testServer.use(http.get('*/bff/v1/docs/:type', ({ request }) => { seen.push(new URL(request.url).search); return HttpResponse.json({ items: [] }); }));
    __setSearch('status=issued,partly_settled&outstanding=positive&view=outstanding');
    ui();
    await screen.findByRole('searchbox');
    await waitFor(() => expect(seen.some((s) => s.includes('outstanding=positive'))).toBe(true));
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

describe('DocList — SP1ab kit debt (F3)', () => {
  const row = (id: string) => ({ id, type: taxInvoice.type, number: id.toUpperCase(), status: 'issued', documentDate: '2026-10-01', partyName: 'ก', total: '1.00', createdByAgent: false });
  it('saved view "ค้างชำระ" shows as selected in the status filter (M10)', async () => {
    __setSearch('status=issued,partly_settled&outstanding=positive&view=outstanding');
    ui();
    const select = await screen.findByRole('combobox', { name: 'สถานะ' });
    expect(select).toHaveValue('issued,partly_settled');
    expect(select).toHaveDisplayValue('ค้างชำระ');
  });
  it('retry after a failed REFETCH with pages on screen refetches page 1, not the next page (SP1ab I8 regression)', async () => {
    const cursors: (string | null)[] = [];
    let mode: 'ok' | 'fail' | 'ok2' = 'ok';
    testServer.use(http.get('*/bff/v1/docs/:type', ({ request }) => {
      cursors.push(new URL(request.url).searchParams.get('cursor'));
      if (mode === 'fail') return HttpResponse.json({ status: 500, code: 'x', title: 'ล้มเหลว' }, { status: 500 });
      return HttpResponse.json({ items: [row(mode === 'ok' ? 'ti-x1' : 'ti-x9')], nextCursor: 'c2' }); // there IS a next page
    }));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    ui([], qc);
    expect(await screen.findByText('TI-X1')).toBeVisible();
    mode = 'fail';
    await act(async () => { await qc.refetchQueries({ predicate: (q) => q.queryKey.includes('docs') }).catch(() => undefined); });
    expect(await screen.findByRole('alert')).toHaveTextContent('ล้มเหลว');
    expect(screen.getByText('TI-X1')).toBeVisible(); // pages already loaded stay; the error sits beside them, never "no data"
    expect(screen.queryByText(/ยังไม่มี/)).toBeNull();
    mode = 'ok2';
    cursors.length = 0;
    await userEvent.click(screen.getByRole('button', { name: 'ลองใหม่' }));
    expect(await screen.findByText('TI-X9')).toBeVisible();
    expect(cursors[0]).toBeNull(); // the retry re-reads page 1 (an I8 regression would call fetchNextPage with cursor c2)
    expect(cursors).not.toContain('c2');
  });
  it('from > to shows an inline error and does not query', async () => {
    const seen: string[] = [];
    testServer.use(http.get('*/bff/v1/docs/:type', ({ request }) => { seen.push(new URL(request.url).search); return HttpResponse.json({ items: [row('ti-x1')] }); }));
    ui();
    await screen.findByText('TI-X1');
    fireEvent.change(screen.getByLabelText('ตั้งแต่วันที่'), { target: { value: '2026-10-10' } });
    await waitFor(() => expect(seen.some((s) => s.includes('from=2026-10-10'))).toBe(true));
    const before = seen.length;
    fireEvent.change(screen.getByLabelText('ถึงวันที่'), { target: { value: '2026-10-01' } });
    expect(await screen.findByText('วันที่เริ่มต้องไม่เกินวันที่สิ้นสุด')).toBeVisible();
    await new Promise((r) => setTimeout(r, 100));
    expect(seen).toHaveLength(before);
    expect(screen.getByText('TI-X1')).toBeVisible(); // the last good result stays, it is not blanked into "no data"
    fireEvent.change(screen.getByLabelText('ถึงวันที่'), { target: { value: '2026-10-20' } });
    await waitFor(() => expect(screen.queryByText('วันที่เริ่มต้องไม่เกินวันที่สิ้นสุด')).toBeNull());
    await waitFor(() => expect(seen.some((s) => s.includes('to=2026-10-20'))).toBe(true));
  });
  it('a URL that already has from > to on first load sends no range and shows the error', async () => {
    const seen: string[] = [];
    testServer.use(http.get('*/bff/v1/docs/:type', ({ request }) => { seen.push(new URL(request.url).search); return HttpResponse.json({ items: [row('ti-x1')] }); }));
    __setSearch('from=2026-10-10&to=2026-10-01');
    ui();
    expect(await screen.findByText('TI-X1')).toBeVisible();
    expect(await screen.findByText('วันที่เริ่มต้องไม่เกินวันที่สิ้นสุด')).toBeVisible();
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((q) => !q.includes('from=') && !q.includes('to='))).toBe(true);
  });
  it('picking "ค้างชำระ" in the status select sets the same filter as the saved view (outstanding=positive too)', async () => {
    ui();
    await screen.findAllByRole('row');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'สถานะ' }), 'issued,partly_settled');
    const url = vi.mocked(useRouter().replace).mock.lastCall![0] as string;
    expect(decodeURIComponent(url)).toContain('status=issued,partly_settled');
    expect(url).toContain('outstanding=positive');
  });
  it('back-forward restores the search box text from the URL', async () => {
    __setSearch('q=นาวา');
    ui();
    const box = await screen.findByRole('searchbox');
    expect(box).toHaveValue('นาวา');
    act(() => __setSearch(''));
    await waitFor(() => expect(box).toHaveValue(''));
    act(() => __setSearch('q=ลิลลี่'));
    await waitFor(() => expect(box).toHaveValue('ลิลลี่'));
  });
  it('a status change inside the search debounce window is not overwritten by the late search (stale filters)', async () => {
    ui();
    await screen.findByRole('searchbox');
    await userEvent.type(screen.getByRole('searchbox'), 'นาวา');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'สถานะ' }), 'draft');
    await waitFor(() => expect(vi.mocked(useRouter().replace).mock.lastCall![0]).toContain('q='));
    const url = vi.mocked(useRouter().replace).mock.lastCall![0] as string;
    expect(url).toContain('status=draft');
  });
  it('bulk action failure keeps the selection and announces the error in the live region', async () => {
    const run = vi.fn(async () => { throw new ApiError({ type: 'about:blank', status: 500, code: 'x', title: 'ทำรายการไม่ได้เพราะระบบขัดข้อง', traceId: 't' }); });
    ui([{ key: 'x', label: 'ทำรายการ', permission: 'doc.TI.read', run }]);
    const rows = await screen.findAllByRole('row');
    await userEvent.click(within(rows[1]).getByRole('checkbox'));
    await userEvent.click(screen.getByRole('button', { name: 'ทำรายการ' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('ทำรายการไม่ได้เพราะระบบขัดข้อง'));
    expect(screen.getByText('เลือก 1 รายการ')).toBeVisible(); // selection kept
    expect(within(screen.getAllByRole('row')[1]).getByRole('checkbox')).toBeChecked();
  });
  it('a successful bulk run refetches the list', async () => {
    let gets = 0;
    testServer.use(http.get('*/bff/v1/docs/:type', () => { gets++; return HttpResponse.json({ items: [row('ti-x1')] }); }));
    ui([{ key: 'x', label: 'ทำรายการ', permission: 'doc.TI.read', run: async () => {} }]);
    const rows = await screen.findAllByRole('row');
    await userEvent.click(within(rows[1]).getByRole('checkbox'));
    const before = gets;
    await userEvent.click(screen.getByRole('button', { name: 'ทำรายการ' }));
    await waitFor(() => expect(gets).toBeGreaterThan(before));
  });
  it('KeyN on a list opens the create route; KeyN while typing in the search box does not', async () => {
    ui();
    await screen.findAllByRole('row');
    const push = vi.mocked(useRouter().push);
    push.mockClear();
    await userEvent.type(screen.getByRole('searchbox'), 'n');
    expect(push).not.toHaveBeenCalled();
    await userEvent.click(document.body);
    await userEvent.keyboard('[KeyN]');
    expect(push).toHaveBeenCalledWith(routesOf(taxInvoice).create);
  });
  it('overdue and agent are server filters: the params reach the request and the rows the server returns are shown as-is', async () => {
    const seen: string[] = [];
    testServer.use(http.get('*/bff/v1/docs/:type', ({ request }) => { seen.push(new URL(request.url).search); return HttpResponse.json({ items: [row('ti-x1')] }); }));
    __setSearch('status=issued,partly_settled&outstanding=positive&overdue=1&agent=1');
    ui();
    expect(await screen.findByText('TI-X1')).toBeVisible(); // no due date on the row: a client-side re-filter would have hidden it
    expect(seen[0]).toContain('overdue=1');
    expect(seen[0]).toContain('agent=1');
  });
});

describe('DocList — filter changes', () => {
  it('the search box element survives a filter change (results swap in place, no skeleton tear-down)', async () => {
    ui();
    const box = await screen.findByRole('searchbox');
    box.focus();
    await userEvent.type(box, 'นาวา');
    await waitFor(() => expect(vi.mocked(useRouter().replace).mock.lastCall![0]).toContain('q='));
    await screen.findAllByRole('row');
    expect(screen.getByRole('searchbox')).toBe(box);
    expect(box).toHaveFocus();
  });
});
