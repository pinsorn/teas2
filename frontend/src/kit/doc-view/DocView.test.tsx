import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CorrectionPlan } from '@/domain/types';
import { taxInvoice } from '@/descriptors/tax-invoice';
import { setSettings } from '@/mocks/settings';
import { loadState, resetState } from '@/mocks/store';
import { testServer } from '@/mocks/test-server';
import { CorrectionPlanDialog } from '../dialogs/CorrectionPlanDialog';
import { DocView } from './DocView';

vi.mock('next/navigation', () => import('@/test/next-navigation'));
beforeAll(() => testServer.listen({ onUnhandledFrame: 'error' }));
afterEach(() => testServer.resetHandlers());
afterAll(() => testServer.close());
beforeEach(() => { localStorage.clear(); resetState(); setSettings({ companyKey: 'vat', role: 'accountant', screenState: 'normal' }); });

const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
const ui = (id: string) => render(<QueryClientProvider client={client()}><DocView descriptor={taxInvoice} id={id} /></QueryClientProvider>);
const find = (pred: (d: ReturnType<typeof loadState>['docs'][number]) => boolean) => loadState().docs.find(pred)!;

describe('DocView', () => {
  it('a replaced TI shows the pointer to its replacement in the chain', async () => {
    const replaced = find((d) => d.type === 'TI' && d.status === 'replaced');
    ui(replaced.id);
    const chain = await screen.findByRole('region', { name: 'เอกสารที่เกี่ยวข้อง' });
    expect(within(chain).getByText(/ออกแทนโดย/)).toBeVisible();
  });
  it('the filing lock is shown with its exit, and fiscal edit is disabled with the reason', async () => {
    setSettings({ screenState: 'locked' });
    const issued = find((d) => d.type === 'TI' && d.status === 'issued');
    ui(issued.id);
    expect(await screen.findByRole('status', { name: 'ล็อก' })).toHaveTextContent('ภ.พ.30');
    expect(screen.getByText(/ออกใบลดหนี้/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'แก้ไข' })).toBeDisabled();
  });
  it('shows the document number with the doc-number test id', async () => {
    const issued = find((d) => d.type === 'TI' && d.status === 'issued' && !d.locks.length);
    ui(issued.id);
    expect(await screen.findByTestId('doc-number')).toHaveTextContent(issued.number!);
  });
  it('cancel needs a reason code', async () => {
    const issued = find((d) => d.type === 'TI' && d.status === 'issued' && !d.locks.length);
    ui(issued.id);
    await userEvent.click(await screen.findByRole('button', { name: 'ยกเลิกเอกสาร' }));
    const dialog = screen.getByRole('alertdialog');
    expect(within(dialog).getByRole('button', { name: 'ยืนยันยกเลิก' })).toBeDisabled();
  });
  it('an operator sees disabled cancel with the missing permission', async () => {
    setSettings({ role: 'operator' });
    const issued = find((d) => d.type === 'TI' && d.status === 'issued' && !d.locks.length);
    ui(issued.id);
    const btn = await screen.findByRole('button', { name: 'ยกเลิกเอกสาร' });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAccessibleDescription(/doc\.TI\.cancel/);
  });
  it('revision history shows the diff of a revised document', async () => {
    const revised = find((d) => d.type === 'QT' && d.revision > 0);
    render(<QueryClientProvider client={client()}><DocView descriptor={{ ...taxInvoice, type: 'QT', correctionClass: 'N', basePath: '/sales/quotations' }} id={revised.id} /></QueryClientProvider>);
    await userEvent.click(await screen.findByRole('tab', { name: 'ประวัติการแก้ไข' }));
    expect(await screen.findByText(/ฉบับแก้ไขครั้งที่ 1/)).toBeVisible();
  });
  it('a load failure is an error with retry, not an empty page', async () => {
    setSettings({ screenState: 'error' });
    ui(find((d) => d.type === 'TI').id);
    expect(await screen.findByRole('button', { name: 'ลองใหม่' })).toBeVisible();
  });
});

describe('CorrectionPlanDialog', () => {
  const plan = (missing: string[]): CorrectionPlan => ({
    planId: 'p', planHash: 'h', explanation: 'ยกเลิกและออกใหม่', missingPermissions: missing,
    steps: [
      { order: 1, action: 'cancel', docId: 'a', docType: 'RC', number: 'RC-1', summary: 'ยกเลิก RC RC-1', permission: 'doc.RC.cancel' },
      { order: 2, action: 'reissue', docId: 'b', docType: 'TI', number: 'TI-1', summary: 'ออก TI ใหม่', permission: 'doc.TI.correct' },
    ],
  });
  it('lists ordered steps and confirms', async () => {
    const onConfirm = vi.fn();
    render(<CorrectionPlanDialog plan={plan([])} onConfirm={onConfirm} onSendToApprover={vi.fn()} onCancel={vi.fn()} />);
    const dialog = screen.getByRole('alertdialog', { name: 'แผนการแก้ไข' });
    expect(within(dialog).getAllByRole('listitem')).toHaveLength(2);
    await userEvent.click(within(dialog).getByRole('button', { name: 'ยืนยันทั้งหมด' }));
    expect(onConfirm).toHaveBeenCalled();
  });
  it('missing permissions disable confirm and offer sending to an approver', async () => {
    const onSend = vi.fn();
    render(<CorrectionPlanDialog plan={plan(['doc.RC.cancel'])} onConfirm={vi.fn()} onSendToApprover={onSend} onCancel={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'ยืนยันทั้งหมด' })).toBeDisabled();
    expect(screen.getByText(/doc\.RC\.cancel/, { selector: 'p' })).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'ส่งให้ผู้มีสิทธิ์อนุมัติ' }));
    await waitFor(() => expect(onSend).toHaveBeenCalled());
  });
});
