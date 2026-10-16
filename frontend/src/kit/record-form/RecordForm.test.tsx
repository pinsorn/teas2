import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecordRow } from '@/domain/records';
import { tinCheckDigit } from '@/domain/tin';
import type { Me } from '@/domain/types';
import { qk } from '@/lib/query/keys';
import { setSettings } from '@/mocks/settings';
import { resetState } from '@/mocks/store';
import { testServer } from '@/mocks/test-server';
import { RECORDS } from '@/records';
import { RecordForm } from './RecordForm';

vi.mock('next/navigation', () => import('@/test/next-navigation'));
beforeAll(() => testServer.listen({ onUnhandledFrame: 'error' }));
afterEach(() => { cleanup(); testServer.resetHandlers(); });
afterAll(() => testServer.close());
beforeEach(() => { localStorage.clear(); resetState(); setSettings({ companyKey: 'vat', role: 'accountant', screenState: 'normal' }); });

const TIN = `010550000000${tinCheckDigit('010550000000')}`;
const customer = RECORDS.customer!, vendor = RECORDS.vendor!;
const problem = (status: number, code: string, title: string, extra: object = {}) =>
  HttpResponse.json({ type: 'about:blank', status, code, title, traceId: 't-1', ...extra }, { status, headers: { 'content-type': 'application/problem+json' } });
const saved: RecordRow = { id: 'pc-99', version: 1, active: true };

function mount(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const r = render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
  return { qc, ...r };
}
const label = (name: string) => screen.getByLabelText(name, { exact: true });
/** A juristic customer with every required field except what the test is about. */
async function fillMinimal(u: ReturnType<typeof userEvent.setup>, o: { code?: string; taxId?: string } = {}) {
  await u.selectOptions(label('ประเภทคู่ค้า'), 'juristic');
  await u.type(label('รหัส'), o.code ?? 'C99');
  await u.type(label('ชื่อ'), 'บริษัท ทดสอบระบบ จำกัด');
  await u.type(label('เลขประจำตัวผู้เสียภาษี'), o.taxId ?? TIN);
}

describe('RecordForm', () => {
  it('maps server fieldErrors to the right inputs and focuses the first one', async () => {
    testServer.use(http.post('*/bff/v1/records/customer', () => problem(422, 'record.invalid', 'ข้อมูลไม่ถูกต้อง', {
      fieldErrors: { name: ['ชื่อซ้ำกับรายการเดิม'], code: ['รหัสนี้ใช้แล้ว'], ghost: ['ช่องที่ไม่มีในฟอร์ม'] } })));
    const u = userEvent.setup();
    mount(<RecordForm descriptor={customer} onSaved={vi.fn()} onCancel={vi.fn()} />);
    await fillMinimal(u);
    await u.click(screen.getByRole('button', { name: 'บันทึก' }));
    await waitFor(() => expect(label('รหัส')).toHaveAccessibleDescription('รหัสนี้ใช้แล้ว'));
    expect(label('รหัส')).toHaveAttribute('aria-invalid', 'true');
    expect(label('ชื่อ')).toHaveAccessibleDescription('ชื่อซ้ำกับรายการเดิม');
    expect(label('เลขประจำตัวผู้เสียภาษี')).not.toHaveAttribute('aria-invalid', 'true'); // an untouched field stays clean
    expect(label('รหัส')).toHaveFocus(); // the first field in form order, not in response order (name came first in the response)
    expect(screen.getByRole('alert')).toHaveTextContent('ช่องที่ไม่มีในฟอร์ม'); // an error with no field is still shown
  });

  it('a bad TIN is stopped by the shape check (no request), the fixed TIN goes through', async () => {
    const posted = vi.fn();
    testServer.use(http.post('*/bff/v1/records/customer', async ({ request }) => { posted(await request.json()); return HttpResponse.json(saved, { status: 201 }); }));
    const onSaved = vi.fn();
    const u = userEvent.setup();
    mount(<RecordForm descriptor={customer} onSaved={onSaved} onCancel={vi.fn()} />);
    await fillMinimal(u, { taxId: `010550000000${(tinCheckDigit('010550000000') + 1) % 10}` });
    await u.click(screen.getByRole('button', { name: 'บันทึก' }));
    expect(await screen.findByText('เลขประจำตัวผู้เสียภาษีไม่ถูกต้อง (ตรวจสอบหลักสุดท้าย)')).toBeVisible();
    expect(posted).not.toHaveBeenCalled();
    await u.clear(label('เลขประจำตัวผู้เสียภาษี'));
    await u.type(label('เลขประจำตัวผู้เสียภาษี'), TIN);
    await u.click(screen.getByRole('button', { name: 'บันทึก' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(saved));
    expect(posted).toHaveBeenCalledWith(expect.objectContaining({ entityKind: 'juristic', code: 'C99', taxId: TIN, branchCode: '00000', vatRegistered: false }));
  });

  it('required fields are marked and reported before any request', async () => {
    const posted = vi.fn();
    testServer.use(http.post('*/bff/v1/records/customer', () => { posted(); return HttpResponse.json(saved, { status: 201 }); }));
    const u = userEvent.setup();
    mount(<RecordForm descriptor={customer} onSaved={vi.fn()} onCancel={vi.fn()} />);
    await u.click(screen.getByRole('button', { name: 'บันทึก' }));
    expect(await screen.findAllByText('ต้องระบุ')).toHaveLength(3); // entityKind, code, name; the TIN is not required for an unset kind
    expect(label('รหัส')).toHaveAttribute('aria-required', 'true');
    expect(posted).not.toHaveBeenCalled();
    await u.selectOptions(label('ประเภทคู่ค้า'), 'juristic'); // a juristic person needs a TIN
    await u.click(screen.getByRole('button', { name: 'บันทึก' }));
    await waitFor(() => expect(screen.getAllByText('ต้องระบุ')).toHaveLength(3));
    expect(label('เลขประจำตัวผู้เสียภาษี')).toHaveAccessibleDescription('ต้องระบุ');
  });

  it('the vendor usual-items picker offers only purchase items (sales-only items are not offered)', async () => {
    mount(<RecordForm descriptor={vendor} onSaved={vi.fn()} onCancel={vi.fn()} />);
    const group = await screen.findByRole('group', { name: 'สินค้าและบริการที่ซื้อบ่อย' });
    await waitFor(() => expect(within(group).getAllByRole('checkbox').length).toBeGreaterThan(0));
    expect(within(group).getByText(/EXP-06 · /)).toBeInTheDocument(); // a purchase item
    expect(within(group).queryByText(/SV-01 · /)).toBeNull(); // a sales-only item
    expect(within(group).queryByText(/GD-01 · /)).toBeNull();
  });

  it('hides fields whose showWhen does not hold and does not send them', async () => {
    const posted = vi.fn();
    testServer.use(http.post('*/bff/v1/records/vendor', async ({ request }) => { posted(await request.json()); return HttpResponse.json(saved, { status: 201 }); }));
    const u = userEvent.setup();
    mount(<RecordForm descriptor={vendor} onSaved={vi.fn()} onCancel={vi.fn()} />);
    const vatD = 'จดทะเบียน VAT-D (ภ.พ.36 ไม่ต้องนำส่ง)';
    expect(screen.queryByLabelText(vatD)).toBeNull();
    await u.selectOptions(label('ประเภทคู่ค้า'), 'foreign');
    await u.click(await screen.findByLabelText(vatD));
    expect(screen.getByLabelText(vatD)).toBeChecked();
    await u.selectOptions(label('ประเภทคู่ค้า'), 'juristic'); // hidden again, although it was ticked
    expect(screen.queryByLabelText(vatD)).toBeNull();
    await u.type(label('รหัส'), 'V99');
    await u.type(label('ชื่อ'), 'ผู้ขายทดสอบ');
    await u.type(label('เลขประจำตัวผู้เสียภาษี'), TIN);
    await u.click(screen.getByRole('button', { name: 'บันทึก' }));
    await waitFor(() => expect(posted).toHaveBeenCalledTimes(1));
    const body = posted.mock.calls[0][0] as Record<string, unknown>;
    expect(body).not.toHaveProperty('vatDRegistered');
    expect(body).toMatchObject({ entityKind: 'juristic', code: 'V99' });
  });

  it('a 409 conflict shows the reload hint and keeps the typed values', async () => {
    testServer.use(http.put('*/bff/v1/records/customer/pc-01', () => problem(409, 'record.version_conflict', 'ข้อมูลนี้ถูกแก้ไขโดยผู้อื่นแล้ว')));
    const row: RecordRow = { id: 'pc-01', version: 1, active: true, entityKind: 'juristic', code: 'C01', name: 'บริษัท นาวาพาณิชย์ จำกัด', taxId: '0105568024684', branchCode: '00000', inUse: true };
    const u = userEvent.setup();
    mount(<RecordForm descriptor={customer} row={row} onSaved={vi.fn()} onCancel={vi.fn()} />);
    expect(label('รหัส')).toHaveAttribute('readonly'); // used on a document: the code is locked
    expect(label('รหัส')).toHaveAccessibleDescription('แก้ไม่ได้หลังจากใช้ในเอกสารแล้ว');
    await u.clear(label('ชื่อ'));
    await u.type(label('ชื่อ'), 'ชื่อที่พิมพ์ไว้');
    await u.click(screen.getByRole('button', { name: 'บันทึก' }));
    expect(await screen.findByText('ข้อมูลนี้ถูกแก้ไขโดยผู้อื่นแล้ว')).toBeVisible();
    expect(screen.getByRole('button', { name: 'โหลดข้อมูลใหม่' })).toBeVisible();
    expect(label('ชื่อ')).toHaveValue('ชื่อที่พิมพ์ไว้'); // nothing typed is lost
  });

  it('remounts empty on company switch (no company-A values saved into B)', async () => {
    const posted = vi.fn();
    testServer.use(http.post('*/bff/v1/records/customer', () => { posted(); return HttpResponse.json(saved, { status: 201 }); }));
    const u = userEvent.setup();
    const { qc } = mount(<RecordForm descriptor={customer} onSaved={vi.fn()} onCancel={vi.fn()} />);
    await u.type(label('ชื่อ'), 'ค่าของบริษัท A');
    await waitFor(() => expect(qc.getQueryData(qk.me())).toBeTruthy());
    const me = qc.getQueryData<Me>(qk.me())!;
    expect(label('ชื่อ')).toHaveValue('ค่าของบริษัท A');
    setSettings({ companyKey: 'nonvat' });
    act(() => { qc.setQueryData(qk.me(), { ...me, activeCompanyId: 'co-nonvat', vatRegistered: false }); });
    await waitFor(() => expect(label('ชื่อ')).toHaveValue(''));
    expect(label('สาขา')).toHaveValue('00000'); // back to the form's own defaults
    await u.click(screen.getByRole('button', { name: 'บันทึก' }));
    expect(await screen.findAllByText('ต้องระบุ')).not.toHaveLength(0);
    expect(posted).not.toHaveBeenCalled();
  });
});
