import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Me } from '@/domain/types';
import { qk } from '@/lib/query/keys';
import { __setSearch } from '@/test/next-navigation';
import { setSettings } from '@/mocks/settings';
import { resetState } from '@/mocks/store';
import { testServer } from '@/mocks/test-server';
import { RECORDS } from '@/records';
import { RecordList } from './RecordList';

vi.mock('next/navigation', () => import('@/test/next-navigation'));
beforeAll(() => testServer.listen({ onUnhandledFrame: 'error' }));
afterEach(() => { cleanup(); testServer.resetHandlers(); testServer.events.removeAllListeners(); });
afterAll(() => testServer.close());
const urls: URL[] = [];
const listCalls = () => urls.filter((u) => u.pathname === '/bff/v1/records/customer');
beforeEach(() => {
  __setSearch(''); localStorage.clear(); resetState(); urls.length = 0;
  setSettings({ companyKey: 'vat', role: 'accountant', screenState: 'normal' });
  testServer.events.on('request:start', ({ request }) => urls.push(new URL(request.url)));
});

const mount = () => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><RecordList descriptor={RECORDS.customer!} /></QueryClientProvider>);

describe('RecordList', () => {
  it('shows the active customers by default, with the inactive one behind the filter', async () => {
    mount();
    expect(await screen.findByRole('heading', { level: 1, name: 'ลูกค้า' })).toBeVisible();
    expect(await screen.findByRole('link', { name: 'C01' })).toHaveAttribute('href', '/master/customers/pc-01');
    expect(screen.getAllByRole('row')).toHaveLength(13); // header + 12 active
    expect(screen.queryByText('บริษัท เลิกกิจการ ตัวอย่าง จำกัด')).toBeNull();
    expect(listCalls()[0].searchParams.get('active')).toBe('true');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'สถานะ' }), 'false');
    expect(await screen.findByText('บริษัท เลิกกิจการ ตัวอย่าง จำกัด')).toBeVisible();
    expect(screen.getAllByRole('row')).toHaveLength(2);
  });

  it('search, active filter and paging go to the server; empty vs error are distinct', async () => {
    mount();
    await screen.findByRole('link', { name: 'C01' });
    await userEvent.type(screen.getByRole('searchbox', { name: 'ค้นหา' }), 'นาวา');
    await waitFor(() => expect(listCalls().some((u) => u.searchParams.get('q') === 'นาวา')).toBe(true));
    await waitFor(() => expect(screen.getAllByRole('row')).toHaveLength(2)); // the server filtered; the browser did not
    expect(listCalls().filter((u) => u.searchParams.get('q')).length).toBe(1); // one request per settled text, not one per key (300 ms debounce)
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'สถานะ' }), 'all');
    await waitFor(() => expect(listCalls().some((u) => u.searchParams.get('active') === 'all' && u.searchParams.get('q') === 'นาวา')).toBe(true));

    // nothing matches the filters: a "no match" state with a way out, not the empty state
    await userEvent.clear(screen.getByRole('searchbox', { name: 'ค้นหา' }));
    await userEvent.type(screen.getByRole('searchbox', { name: 'ค้นหา' }), 'ไม่มีชื่อนี้แน่นอน');
    expect(await screen.findByText('ไม่พบรายการที่ตรงกับตัวกรอง')).toBeVisible();
    expect(screen.queryByText('ยังไม่มีลูกค้า')).toBeNull();
    const noMatch = screen.getByText('ไม่พบรายการที่ตรงกับตัวกรอง').parentElement as HTMLElement;
    await userEvent.click(within(noMatch).getByRole('button', { name: 'ล้างตัวกรอง' }));
    expect(await screen.findByRole('link', { name: 'C01' })).toBeVisible();
  });

  it('pages with the server cursor', async () => {
    const row = (n: number) => ({ id: `x-${n}`, version: 1, active: true, code: `X${n}`, name: `ลูกค้า ${n}` });
    testServer.use(http.get('*/bff/v1/records/customer', ({ request }) => {
      const cursor = new URL(request.url).searchParams.get('cursor');
      return HttpResponse.json(cursor ? { items: [row(2)] } : { items: [row(1)], nextCursor: 'c-2' });
    }));
    mount();
    await screen.findByRole('link', { name: 'X1' });
    await userEvent.click(screen.getByRole('button', { name: 'โหลดเพิ่ม' }));
    expect(await screen.findByRole('link', { name: 'X2' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'X1' })).toBeVisible();
    expect(listCalls().map((u) => u.searchParams.get('cursor'))).toEqual([null, 'c-2']);
    expect(screen.queryByRole('button', { name: 'โหลดเพิ่ม' })).toBeNull();
  });

  it('an empty answer says so and offers the create step; an error is an error, never "no data"', async () => {
    setSettings({ screenState: 'empty' });
    const { container, unmount } = mount();
    expect(await screen.findByText('ยังไม่มีลูกค้า')).toBeVisible();
    expect(container.querySelector('[data-screen-state="empty"]')).not.toBeNull();
    expect(within(container.querySelector('[data-screen-state="empty"]') as HTMLElement).getByRole('button', { name: 'เพิ่มลูกค้า' })).toBeEnabled();
    unmount();
    setSettings({ screenState: 'error' });
    const e = mount();
    expect(await screen.findByRole('alert')).toHaveTextContent('ระบบขัดข้องชั่วคราว');
    expect(e.container.querySelector('[data-screen-state="empty"]')).toBeNull();
    expect(screen.queryByText('ยังไม่มีลูกค้า')).toBeNull();
    expect(screen.getByRole('button', { name: 'ลองใหม่' })).toBeVisible();
  });

  it('forbidden names the missing permission', async () => {
    setSettings({ screenState: 'forbidden' });
    const { container } = mount();
    expect(await screen.findByText(/ต้องมีสิทธิ์ party.read/)).toBeVisible();
    expect(container.querySelector('[data-screen-state="forbidden"]')).not.toBeNull();
  });

  it('create button is disabled with the manage permission named when missing', async () => {
    setSettings({ role: 'admin' });
    mount();
    await screen.findByRole('link', { name: 'C01' });
    const btn = screen.getByRole('button', { name: 'เพิ่มลูกค้า' });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAccessibleDescription('ต้องมีสิทธิ์ party.manage');
    await userEvent.click(btn);
    expect(screen.queryByRole('dialog')).toBeNull(); // a disabled button opens nothing
  });

  it('create opens the form in a dialog named after the action; saving closes it and the new row shows', async () => {
    mount();
    await screen.findByRole('link', { name: 'C01' });
    await userEvent.click(screen.getByRole('button', { name: 'เพิ่มลูกค้า' }));
    const dialog = await screen.findByRole('dialog', { name: 'เพิ่มลูกค้า' });
    await userEvent.selectOptions(within(dialog).getByLabelText('ประเภทคู่ค้า'), 'individual');
    await userEvent.type(within(dialog).getByLabelText('รหัส'), 'C99');
    await userEvent.type(within(dialog).getByLabelText('ชื่อ', { exact: true }), 'คุณทดสอบ ระบบ');
    await userEvent.click(within(dialog).getByRole('button', { name: 'บันทึก' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await screen.findByRole('link', { name: 'C99' })).toBeVisible();
  });

  it('remounts on company switch: the typed search and the other company rows never carry over', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><RecordList descriptor={RECORDS.customer!} /></QueryClientProvider>);
    await userEvent.type(await screen.findByRole('searchbox', { name: 'ค้นหา' }), 'ศรี');
    await waitFor(() => expect(screen.getAllByRole('link', { name: /^C\d\d$/ }).every((a) => a.getAttribute('href')!.includes('/pc-'))).toBe(true));
    const me = qc.getQueryData<Me>(qk.me())!;
    __setSearch('');
    setSettings({ companyKey: 'nonvat' });
    act(() => { qc.setQueryData(qk.me(), { ...me, activeCompanyId: 'co-nonvat', vatRegistered: false }); });
    await waitFor(() => expect(screen.getByRole('searchbox', { name: 'ค้นหา' })).toHaveValue(''));
    await waitFor(() => expect(screen.getByRole('link', { name: 'C01' })).toHaveAttribute('href', '/master/customers/nc-01'));
    expect(screen.queryAllByRole('link').filter((a) => a.getAttribute('href')?.includes('/pc-'))).toHaveLength(0);
  });
});
