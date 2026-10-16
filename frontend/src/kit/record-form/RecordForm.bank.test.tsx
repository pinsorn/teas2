import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecordRow } from '@/domain/records';
import { endpoints } from '@/lib/api/endpoints';
import { setSettings } from '@/mocks/settings';
import { loadState, resetState } from '@/mocks/store';
import { testServer } from '@/mocks/test-server';
import { RECORDS } from '@/records';
import { RecordForm } from './RecordForm';

vi.mock('next/navigation', () => import('@/test/next-navigation'));
beforeAll(() => testServer.listen({ onUnhandledFrame: 'error' }));
afterEach(() => { cleanup(); testServer.resetHandlers(); });
afterAll(() => testServer.close());
beforeEach(() => { localStorage.clear(); resetState(); setSettings({ companyKey: 'vat', role: 'accountant', screenState: 'normal' }); });

const bank = RECORDS['bank-account']!;
const mount = (ui: React.ReactElement) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>);
const label = (name: string) => screen.getByLabelText(name, { exact: true });

describe('bank account form', () => {
  it('a bank account asks for bank and number; a cash box does not; the GL picker offers only the free accounts of that type', async () => {
    const onSaved = vi.fn();
    mount(<RecordForm descriptor={bank} onSaved={onSaved} onCancel={() => undefined} />);
    const u = userEvent.setup();
    const gl = await screen.findByLabelText('บัญชีแยกประเภท');
    await waitFor(() => expect(within(gl).getAllByRole('option').length).toBeGreaterThan(1));
    expect(within(gl).getAllByRole('option').map((o) => o.textContent)).toEqual(['— เลือกบัญชีแยกประเภท —', '1120 · เงินฝากธนาคาร']); // 1121 / 1122 belong to the two existing banks
    await u.selectOptions(label('ประเภทบัญชี'), 'cash');
    expect(screen.queryByLabelText('ธนาคาร')).toBeNull();
    expect(screen.queryByLabelText('เลขที่บัญชี')).toBeNull();
    expect(within(gl).getAllByRole('option').map((o) => o.textContent)).toEqual(['— เลือกบัญชีแยกประเภท —']); // the only cash account is ba-cash's
    await u.selectOptions(label('ประเภทบัญชี'), 'bank');
    await u.selectOptions(label('ธนาคาร'), 'bbl');
    await u.type(label('เลขที่บัญชี'), '999-9-99999-9');
    await u.type(label('ชื่อบัญชี'), 'กรุงเทพ ออมทรัพย์');
    await u.selectOptions(label('บัญชีแยกประเภท'), '1120');
    await u.click(screen.getByRole('button', { name: 'บันทึก' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(loadState().bankAccounts.find((b) => b.id === 'ba-4')).toMatchObject({ kind: 'bank', bankName: 'bbl', accountNo: '999-9-99999-9', accountCode: '1120' });
  });

  it('shape errors show on the fields before anything is sent; a server error (taken number) lands on its field', async () => {
    mount(<RecordForm descriptor={bank} onSaved={() => undefined} onCancel={() => undefined} />);
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'บันทึก' }));
    expect((await screen.findAllByText('ต้องระบุ')).length).toBeGreaterThanOrEqual(3); // bank, number, name, GL account
    await u.selectOptions(label('ธนาคาร'), 'kbank');
    await u.type(label('เลขที่บัญชี'), '0123456789'); // ba-kbank's number without dashes
    await u.type(label('ชื่อบัญชี'), 'ซ้ำ');
    await waitFor(() => expect(within(screen.getByLabelText('บัญชีแยกประเภท')).getAllByRole('option').length).toBeGreaterThan(1));
    await u.selectOptions(label('บัญชีแยกประเภท'), '1120');
    await u.click(screen.getByRole('button', { name: 'บันทึก' }));
    expect(await screen.findByText('เลขที่บัญชีนี้ใช้แล้ว')).toBeVisible();
    expect(loadState().bankAccounts).toHaveLength(5);
  });

  it('a GL account that has posted is shown read-only with the reason; one that has not can still move', async () => {
    const rows = (await endpoints.listRecords('bank-account', { active: 'all' })).items;
    const used = rows.find((r) => r.id === 'ba-kbank') as RecordRow, fresh = rows.find((r) => r.id === 'ba-scb') as RecordRow;
    expect([used.inUse, fresh.inUse]).toEqual([true, false]);
    mount(<RecordForm descriptor={bank} row={used} onSaved={() => undefined} onCancel={() => undefined} />);
    const code = await screen.findByLabelText('บัญชีแยกประเภท');
    expect(code).toHaveAttribute('readonly');
    expect(code).toHaveValue('1121');
    expect(screen.getByText('แก้ไม่ได้หลังจากใช้ในเอกสารแล้ว')).toBeVisible();
    cleanup();
    mount(<RecordForm descriptor={bank} row={fresh} onSaved={() => undefined} onCancel={() => undefined} />);
    const free = await screen.findByLabelText('บัญชีแยกประเภท');
    expect(free.tagName).toBe('SELECT');
    await waitFor(() => expect(within(free).getAllByRole('option').map((o) => o.textContent)).toEqual(['— เลือกบัญชีแยกประเภท —', '1120 · เงินฝากธนาคาร', '1122 · ธ.ไทยพาณิชย์ ออมทรัพย์']));
    expect(free).toHaveValue('1122');
  });
});
