import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { taxInvoice } from '@/descriptors/tax-invoice';
import type { Doc } from '@/domain/types';
import { setSettings } from '@/mocks/settings';
import { resetState } from '@/mocks/store';
import { testServer } from '@/mocks/test-server';
import { DocEditor } from './DocEditor';

vi.mock('next/navigation', () => import('@/test/next-navigation'));
beforeAll(() => testServer.listen({ onUnhandledFrame: 'error' }));
afterEach(async () => { cleanup(); await new Promise((r) => setTimeout(r, 150)); testServer.resetHandlers(); });
afterAll(() => testServer.close());
beforeEach(() => { localStorage.clear(); resetState(); setSettings({ companyKey: 'vat', role: 'accountant', screenState: 'normal' }); });

// AC7b: the template of a recurring schedule in the normal editor: prefilled, no date / number / issue, "บันทึกแม่แบบ" hands { header, lines } to the caller.
const initial = { id: '', type: 'TI', status: 'draft', correctionClass: 'T', revision: 0, version: 1, header: { partyId: 'pc-04', documentDate: '2026-11-01', reference: 'PO-1' },
  lines: [{ id: 'tl-1', description: 'ดูแลเว็บไซต์รายเดือน', qty: '1', unit: 'เดือน', unitPrice: '8000.00', taxCode: 'S7' }], totals: {}, locks: [], createdBy: { kind: 'user', id: '', name: '' } } as unknown as Doc;
const ui = (onSaveTemplate: (p: { header: unknown; lines: unknown[] }) => Promise<unknown>) => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><DocEditor descriptor={taxInvoice} mode="template" initial={{ ...initial, party: undefined }} onIssued={vi.fn()} onSaveTemplate={onSaveTemplate} /></QueryClientProvider>);

describe('DocEditor: template mode (AC7b)', () => {
  it('is the normal editor without a date, a number or an issue action; its primary action saves the edited template', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    ui(save);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('แก้ไขแม่แบบ');
    expect(screen.queryByLabelText('วันที่เอกสาร')).toBeNull();
    expect(screen.queryByRole('button', { name: /^ออก/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'บันทึก' })).toBeNull(); // no draft is saved from here
    const button = screen.getByRole('button', { name: 'บันทึกแม่แบบ' });
    await waitFor(() => expect(button).toBeEnabled(), { timeout: 12000 });
    await userEvent.clear(screen.getByRole('textbox', { name: /^ราคาต่อหน่วย/ }));
    await userEvent.type(screen.getByRole('textbox', { name: /^ราคาต่อหน่วย/ }), '9500');
    await waitFor(() => expect(button).toBeEnabled(), { timeout: 12000 });
    await userEvent.click(button);
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0][0]).toMatchObject({ header: { partyId: 'pc-04', reference: 'PO-1' }, lines: [{ id: 'tl-1', description: 'ดูแลเว็บไซต์รายเดือน', unitPrice: '9500.00' }] });
  }, 30000);

  it('shows a refusal in place and stays on the editor', async () => {
    ui(vi.fn().mockRejectedValue(new Error('no')));
    const button = screen.getByRole('button', { name: 'บันทึกแม่แบบ' });
    await waitFor(() => expect(button).toBeEnabled(), { timeout: 12000 });
    await userEvent.click(button);
    expect(await screen.findByText('บันทึกแม่แบบไม่สำเร็จ')).toBeVisible();
    expect(screen.getByRole('button', { name: 'บันทึกแม่แบบ' })).toBeEnabled();
  }, 30000);

  it('is the schedule manager\'s: without ledger.schedule.manage the action is disabled', async () => {
    setSettings({ companyKey: 'vat', role: 'operator', screenState: 'normal' });
    ui(vi.fn());
    expect(await screen.findByText('คุณไม่มีสิทธิ์ทำรายการนี้')).toBeVisible(); // the operator may issue a TI but does not manage schedules
    expect(screen.getByRole('button', { name: 'บันทึกแม่แบบ' })).toBeDisabled();
  });
});
