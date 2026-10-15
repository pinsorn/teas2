import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http } from 'msw';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { __setSearch } from '@/test/next-navigation';
import { setSettings } from '@/mocks/settings';
import { loadState, resetState } from '@/mocks/store';
import { testServer } from '@/mocks/test-server';
import { RECORDS } from '@/records';
import { RecordList } from './RecordList';

vi.mock('next/navigation', () => import('@/test/next-navigation'));
beforeAll(() => testServer.listen({ onUnhandledFrame: 'error' }));
afterEach(() => { cleanup(); testServer.resetHandlers(); testServer.events.removeAllListeners(); });
afterAll(() => testServer.close());
beforeEach(() => {
  __setSearch(''); localStorage.clear(); resetState();
  setSettings({ companyKey: 'vat', role: 'accountant', screenState: 'normal' });
});

const mount = () => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><RecordList descriptor={RECORDS.item!} /></QueryClientProvider>);
const rowOf = (code: string) => screen.getByRole('button', { name: code }).closest('tr')!;
const api = (path: string, init?: RequestInit) => fetch(`http://localhost/bff/v1${path}`, { headers: { 'content-type': 'application/json' }, ...init });

describe('item list and form (a record kind with no detail page)', () => {
  it('lists items with labelled kind, VAT and usage; the first column opens the edit dialog', async () => {
    mount();
    expect(await screen.findByRole('heading', { level: 1, name: 'สินค้า/บริการ' })).toBeVisible();
    await screen.findByRole('button', { name: 'EXP-01' });
    const r = rowOf('EXP-01');
    expect(within(r).getByText('บริการ')).toBeVisible();
    expect(within(r).getByText('ซื้อ')).toBeVisible();
    expect(within(r).getByText('VAT 7%')).toBeVisible();
    expect(within(r).getByText('25,000.00')).toBeVisible();
    expect(within(rowOf('SV-01')).getByText('ขาย')).toBeVisible();
    expect(screen.queryByRole('link', { name: 'EXP-01' })).toBeNull(); // detail: false
  });

  it('edit from the row: conditional fields follow the kind and the purchase usage', async () => {
    mount();
    await userEvent.click(await screen.findByRole('button', { name: 'SV-01' }));
    const dialog = await screen.findByRole('dialog', { name: 'แก้ไขสินค้า/บริการ' });
    expect(within(dialog).getByLabelText('ชื่อ', { exact: true })).toHaveValue('ออกแบบอัตลักษณ์องค์กร');
    expect(within(dialog).getByLabelText('ภาษีมูลค่าเพิ่ม')).toHaveValue('S7');
    expect(within(dialog).getByLabelText('ประเภทภาษีหัก ณ ที่จ่าย')).toBeVisible(); // a service
    expect(within(dialog).queryByLabelText('หมวดค่าใช้จ่าย')).toBeNull(); // not a purchase item
    await userEvent.click(within(dialog).getByLabelText('ใช้ในเอกสารซื้อ'));
    expect(within(dialog).getByLabelText('หมวดค่าใช้จ่าย')).toBeVisible();
    await userEvent.selectOptions(within(dialog).getByLabelText('ประเภท'), 'good');
    expect(within(dialog).queryByLabelText('ประเภทภาษีหัก ณ ที่จ่าย')).toBeNull();
  });

  it('saving from the row dialog updates the list and the item is usable as a purchase item', async () => {
    mount();
    await userEvent.click(await screen.findByRole('button', { name: 'SV-02' }));
    const dialog = await screen.findByRole('dialog', { name: 'แก้ไขสินค้า/บริการ' });
    await userEvent.click(within(dialog).getByLabelText('ใช้ในเอกสารซื้อ'));
    await userEvent.selectOptions(within(dialog).getByLabelText('หมวดค่าใช้จ่าย'), 'services');
    await userEvent.click(within(dialog).getByRole('button', { name: 'บันทึก' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await within(rowOf('SV-02')).findByText('ขายและซื้อ')).toBeVisible();
    expect(loadState().items.find((i) => i.id === 'SV-02')).toMatchObject({ usage: { sales: true, purchase: true }, expenseCategory: 'services' });
  });

  it('a 409 in the row dialog: reload fetches the item, keeps the typed values, and the next save carries the fresh version', async () => {
    const putVersions: unknown[] = [];
    testServer.use(http.put('*/bff/v1/records/item/:id', async ({ request }) => {
      putVersions.push(((await request.clone().json()) as { version: number }).version);
      return undefined;
    }));
    mount();
    await userEvent.click(await screen.findByRole('button', { name: 'SV-03' }));
    const dialog = await screen.findByRole('dialog', { name: 'แก้ไขสินค้า/บริการ' });
    const cur = (await (await api('/records/item/SV-03')).json()) as Record<string, unknown>;
    expect((await api('/records/item/SV-03', { method: 'PUT', body: JSON.stringify({ ...cur, unit: 'ชุด' }) })).status).toBe(200); // someone else saves: v2
    putVersions.length = 0;
    const name = within(dialog).getByLabelText('ชื่อ', { exact: true });
    await userEvent.clear(name);
    await userEvent.type(name, 'ชื่อที่ฉันพิมพ์');
    await userEvent.click(within(dialog).getByRole('button', { name: 'บันทึก' }));
    await userEvent.click(await within(dialog).findByRole('button', { name: 'โหลดข้อมูลใหม่' }));
    await waitFor(() => expect(within(dialog).queryByRole('button', { name: 'โหลดข้อมูลใหม่' })).toBeNull());
    expect(name).toHaveValue('ชื่อที่ฉันพิมพ์');
    await userEvent.click(within(dialog).getByRole('button', { name: 'บันทึก' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(putVersions).toEqual([1, 2]);
    expect(loadState().items.find((i) => i.id === 'SV-03')).toMatchObject({ name: 'ชื่อที่ฉันพิมพ์', version: 3 });
  });

  it('non-VAT company: the VAT field is absent from the form and the item is stored EX', async () => {
    setSettings({ companyKey: 'nonvat' });
    mount();
    await userEvent.click(await screen.findByRole('button', { name: 'เพิ่มสินค้า/บริการ' }));
    const dialog = await screen.findByRole('dialog', { name: 'เพิ่มสินค้า/บริการ' });
    expect(within(dialog).queryByLabelText('ภาษีมูลค่าเพิ่ม')).toBeNull();
    await userEvent.selectOptions(within(dialog).getByLabelText('ประเภท'), 'good');
    await userEvent.type(within(dialog).getByLabelText('รหัส'), 'NV-9');
    await userEvent.type(within(dialog).getByLabelText('ชื่อ', { exact: true }), 'ข้าวทดสอบ');
    await userEvent.type(within(dialog).getByLabelText('หน่วย'), 'ถุง');
    await userEvent.click(within(dialog).getByRole('button', { name: 'บันทึก' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(loadState().items.find((i) => i.code === 'NV-9')).toMatchObject({ taxCode: 'EX', companyId: 'co-nonvat', usage: { sales: true, purchase: false } });
  });

  it('VAT company create: the VAT field defaults to 7 % and the server error lands on the field', async () => {
    mount();
    await userEvent.click(await screen.findByRole('button', { name: 'เพิ่มสินค้า/บริการ' }));
    const dialog = await screen.findByRole('dialog', { name: 'เพิ่มสินค้า/บริการ' });
    expect(within(dialog).getByLabelText('ภาษีมูลค่าเพิ่ม')).toHaveValue('S7');
    await userEvent.selectOptions(within(dialog).getByLabelText('ประเภท'), 'service');
    await userEvent.type(within(dialog).getByLabelText('รหัส'), 'SV-01');
    await userEvent.type(within(dialog).getByLabelText('ชื่อ', { exact: true }), 'บริการทดสอบ');
    await userEvent.type(within(dialog).getByLabelText('หน่วย'), 'งาน');
    await userEvent.click(within(dialog).getByRole('button', { name: 'บันทึก' }));
    expect(await within(dialog).findByText('รหัสนี้ใช้แล้ว')).toBeVisible();
  });

  it('an operator may read items but cannot add or edit them: the button is disabled and says which permission', async () => {
    setSettings({ role: 'operator' });
    mount();
    const btn = await screen.findByRole('button', { name: 'เพิ่มสินค้า/บริการ' });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAccessibleDescription('ต้องมีสิทธิ์ item.manage');
    await userEvent.click(screen.getByRole('button', { name: 'SV-01' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('deactivating from the list filter: the item leaves the active list and shows under "ปิดใช้งาน"', async () => {
    mount();
    await screen.findByRole('button', { name: 'GD-01' });
    const cur = (await (await api('/records/item/GD-01')).json()) as { version: number };
    await api('/records/item/GD-01/active', { method: 'POST', body: JSON.stringify({ active: false, version: cur.version }) });
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'สถานะ' }), 'false');
    expect(await screen.findByRole('button', { name: 'GD-01' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'SV-01' })).toBeNull();
  });
});

