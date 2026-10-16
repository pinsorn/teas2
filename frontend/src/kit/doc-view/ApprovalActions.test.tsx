import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { expenseClaim } from '@/descriptors/expense-claim';
import type { Doc, Role } from '@/domain/types';
import { endpoints } from '@/lib/api/endpoints';
import { PERMISSIONS_BY_ROLE } from '@/mocks/permissions';
import { setSettings } from '@/mocks/settings';
import { loadState, resetState } from '@/mocks/store';
import { testServer } from '@/mocks/test-server';
import { ApprovalActions } from './ApprovalActions';

vi.mock('next/navigation', () => import('@/test/next-navigation'));
beforeAll(() => testServer.listen({ onUnhandledFrame: 'error' }));
afterEach(() => { cleanup(); testServer.resetHandlers(); });
afterAll(() => testServer.close());
beforeEach(() => { localStorage.clear(); resetState(); setSettings({ companyKey: 'vat', role: 'accountant', screenState: 'normal' }); });

Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => {};
Element.prototype.releasePointerCapture ??= () => {};
Element.prototype.scrollIntoView ??= () => {};

/** The document as the screen reads it (the server derives `approvalRequired` of a draft), rendered with the permissions of the role. */
async function open(id: string, role: Role) {
  setSettings({ role });
  const doc: Doc = await endpoints.getDoc('EX', id);
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <TooltipProvider><ApprovalActions descriptor={expenseClaim} doc={doc} permissions={PERMISSIONS_BY_ROLE[role]} companyId="co-vat" /></TooltipProvider>
    </QueryClientProvider>,
  );
  return doc;
}
const stored = (id: string) => loadState().docs.find((d) => d.id === id)!;

describe('ApprovalActions: a draft the policy wants approved', () => {
  it('the operator (no approve right) sees "ส่งอนุมัติ" and submits; there is no approve-and-issue for them', async () => {
    await open('ex-d1', 'operator');
    expect(screen.queryByRole('button', { name: 'อนุมัติและออก' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'ส่งอนุมัติ' }));
    await waitFor(() => expect(stored('ex-d1').status).toBe('pending'));
    expect(stored('ex-d1').number).toBeUndefined();
  });
  it('the accountant (approve + issue) sees "อนุมัติและออก" and one click issues it with one number', async () => {
    await open('ex-d1', 'accountant');
    expect(screen.queryByRole('button', { name: 'ส่งอนุมัติ' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'อนุมัติและออก' }));
    await waitFor(() => expect(stored('ex-d1').status).toBe('issued'));
    expect(stored('ex-d1').number).toMatch(/^EX-\d{6}-\d{4}$/);
    expect(stored('ex-d1').approval?.approvedBy).toBeTruthy();
  });
});

describe('ApprovalActions: a pending document', () => {
  it('the accountant approves, approves-and-issues, or sends back; the operator can do none of them and is told why', async () => {
    await open('ex-pend', 'accountant');
    expect(screen.getByRole('button', { name: 'อนุมัติ' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'อนุมัติและออก' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'ส่งกลับแก้ไข' })).toBeEnabled();
    cleanup();
    await open('ex-pend', 'operator');
    expect(screen.getByRole('button', { name: 'อนุมัติ' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'อนุมัติ' })).toHaveAccessibleDescription(/doc\.EX\.approve/);
    expect(screen.getByRole('button', { name: 'ส่งกลับแก้ไข' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'อนุมัติและออก' })).toBeNull();
  });
  it('approve moves it to approved (still no number)', async () => {
    await open('ex-pend', 'accountant');
    await userEvent.click(screen.getByRole('button', { name: 'อนุมัติ' }));
    await waitFor(() => expect(stored('ex-pend').status).toBe('approved'));
    expect(stored('ex-pend').number).toBeUndefined();
  });
  it('send back asks for a reason: the confirm button stays off until one is typed, then the draft carries it on its timeline', async () => {
    await open('ex-pend', 'accountant');
    await userEvent.click(screen.getByRole('button', { name: 'ส่งกลับแก้ไข' }));
    const dlg = await screen.findByRole('alertdialog');
    const confirm = within(dlg).getByRole('button', { name: 'ส่งกลับแก้ไข' });
    expect(confirm).toBeDisabled();
    await userEvent.type(within(dlg).getByLabelText('เหตุผลที่ส่งกลับ'), '   ');
    expect(confirm).toBeDisabled();
    await userEvent.type(within(dlg).getByLabelText('เหตุผลที่ส่งกลับ'), 'ใบเสร็จไม่ชัด');
    await userEvent.click(confirm);
    await waitFor(() => expect(stored('ex-pend').status).toBe('draft'));
    const last = loadState().activity.filter((a) => a.docId === 'ex-pend').at(-1)!;
    expect(last).toMatchObject({ action: 'send_back', detail: 'ส่งกลับแก้ไข: ใบเสร็จไม่ชัด' });
  });
});

describe('ApprovalActions: an approved document', () => {
  it('can still be sent back by an approver; nothing else here (issuing is the bar\'s edit/issue button)', async () => {
    await open('ex-appr', 'accountant');
    expect(screen.getByRole('button', { name: 'ส่งกลับแก้ไข' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'ส่งอนุมัติ' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'อนุมัติ' })).toBeNull();
    expect(screen.getByTestId('approval-note')).toHaveTextContent('อนุมัติแล้ว');
  });
});
