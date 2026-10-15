import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatTHB } from '@/lib/format';
import { setSettings } from '@/mocks/settings';
import { resetState } from '@/mocks/store';
import { testServer } from '@/mocks/test-server';
import { RECORDS } from '@/records';
import { RecordView } from './RecordView';

vi.mock('next/navigation', () => import('@/test/next-navigation'));
beforeAll(() => testServer.listen({ onUnhandledFrame: 'error' }));
afterEach(() => { cleanup(); testServer.resetHandlers(); testServer.events.removeAllListeners(); });
afterAll(() => testServer.close());
beforeEach(() => { localStorage.clear(); resetState(); setSettings({ companyKey: 'vat', role: 'accountant', screenState: 'normal' }); });

const mount = (id = 'pc-01', kind: 'customer' | 'vendor' = 'customer') =>
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><RecordView descriptor={RECORDS[kind]!} id={id} /></QueryClientProvider>);

describe('RecordView', () => {
  it('header carries name, TIN, branch and status; the details tab shows the fields read-only', async () => {
    mount();
    expect(await screen.findByRole('heading', { level: 1, name: 'บริษัท นาวาพาณิชย์ จำกัด' })).toBeVisible();
    expect(screen.getAllByText('0105568024684').length).toBeGreaterThan(0);
    expect(screen.getByText('ใช้งาน', { selector: '[data-slot="badge"]' })).toBeVisible();
    const tab = screen.getByRole('tabpanel');
    expect(within(tab).getByText('นิติบุคคล')).toBeVisible(); // select value shown as its label, not the code
    expect(within(tab).queryByRole('textbox')).toBeNull(); // read-only
  });

  it('the open-items tab shows the rows and the TOTAL from the server (the browser adds nothing)', async () => {
    mount();
    await screen.findByRole('heading', { level: 1 });
    await userEvent.click(screen.getByRole('tab', { name: 'ยอดค้าง' }));
    const server = (await (await fetch('http://localhost/bff/v1/docs/open-items?partyId=pc-01&types=TI,IV')).json()) as { items: unknown[]; total: string };
    const panel = await screen.findByRole('tabpanel');
    await waitFor(() => expect(within(panel).getAllByRole('row')).toHaveLength(server.items.length + 1)); // header + one row per item
    expect(server.items.length).toBeGreaterThanOrEqual(2);
    expect(within(panel).getByRole('status')).toHaveTextContent(formatTHB(server.total));
  }, 10_000);

  it('the total line is the response total, even when it disagrees with the rows', async () => {
    testServer.use(http.get('*/bff/v1/docs/open-items', () => HttpResponse.json({ items: [], total: '12345.67' })));
    mount();
    await screen.findByRole('heading', { level: 1 });
    await userEvent.click(screen.getByRole('tab', { name: 'ยอดค้าง' }));
    expect(await screen.findByText('ไม่มียอดค้าง')).toBeVisible(); // no rows: the empty state wins
    testServer.use(http.get('*/bff/v1/docs/open-items', () => HttpResponse.json({
      items: [{ id: 'd1', type: 'TI', number: 'TI-202610-0001', documentDate: '2026-10-01', total: '100.00', outstanding: '100.00' }], total: '12345.67' })));
    cleanup();
    mount();
    await userEvent.click(await screen.findByRole('tab', { name: 'ยอดค้าง' }));
    expect(await screen.findByRole('status')).toHaveTextContent(formatTHB('12345.67'));
  });

  it('the documents tab lists the party documents across types', async () => {
    mount();
    await userEvent.click(await screen.findByRole('tab', { name: 'เอกสาร' }));
    const panel = await screen.findByRole('tabpanel');
    expect((await within(panel).findAllByRole('link', { name: /^TI-\d{6}-\d{4}$/ })).length).toBeGreaterThan(1);
    expect(within(panel).getAllByRole('row').length).toBeGreaterThan(3);
  });

  it('a role without document read sees "forbidden" on the open-items tab, never "nothing outstanding"', async () => {
    setSettings({ role: 'admin' });
    const { container } = mount();
    await userEvent.click(await screen.findByRole('tab', { name: 'ยอดค้าง' }));
    await waitFor(() => expect(container.querySelector('[data-screen-state="forbidden"]')).not.toBeNull());
    expect(screen.queryByText('ไม่มียอดค้าง')).toBeNull();
    expect(screen.getByRole('button', { name: 'แก้ไข' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'แก้ไข' })).toHaveAccessibleDescription('ต้องมีสิทธิ์ party.manage');
  });

  it('a refused deactivation shows the server reason; success flips the chip and the button', async () => {
    testServer.use(http.post('*/bff/v1/records/customer/pc-01/active', () => HttpResponse.json(
      { type: 'about:blank', status: 409, code: 'record.in_use', title: 'ปิดใช้งานไม่ได้', detail: 'ผังบัญชีผูกกับกฎการลงบัญชี', traceId: 't' }, { status: 409, headers: { 'content-type': 'application/problem+json' } })));
    const calls: string[] = [];
    testServer.events.on('request:start', ({ request }) => { if (request.url.endsWith('/active')) calls.push(request.method); });
    mount();
    // deactivation asks first and says what it does to existing documents; Cancel changes nothing
    await userEvent.click(await screen.findByRole('button', { name: 'ปิดใช้งาน' }));
    const confirm = await screen.findByRole('alertdialog');
    expect(confirm).toHaveTextContent('เอกสารเดิมไม่เปลี่ยน');
    await userEvent.click(within(confirm).getByRole('button', { name: 'ยกเลิก' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(calls).toEqual([]);
    await userEvent.click(screen.getByRole('button', { name: 'ปิดใช้งาน' }));
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'ปิดใช้งาน' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('ผังบัญชีผูกกับกฎการลงบัญชี');
    expect(screen.getByRole('button', { name: 'ปิดใช้งาน' })).toBeVisible(); // still active
    testServer.resetHandlers();
    await userEvent.click(screen.getByRole('button', { name: 'ปิดใช้งาน' }));
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'ปิดใช้งาน' }));
    expect(await screen.findByRole('button', { name: 'เปิดใช้งาน' })).toBeVisible();
    expect(screen.getByText('ปิดใช้งาน', { selector: '[data-slot="badge"]' })).toBeVisible();
  });

  it('a record of another company is "not found"; a server failure is an error with retry', async () => {
    setSettings({ companyKey: 'nonvat' });
    const { container, unmount } = mount('pc-01');
    await waitFor(() => expect(container.querySelector('[data-screen-state="not-found"]')).not.toBeNull());
    expect(screen.getByText('ไม่พบข้อมูลนี้')).toBeVisible();
    unmount();
    setSettings({ screenState: 'error' });
    const e = mount('nc-01');
    await waitFor(() => expect(e.container.querySelector('[data-screen-state="error"]')).not.toBeNull());
    expect(screen.getByRole('button', { name: 'ลองใหม่' })).toBeVisible();
  });
});
