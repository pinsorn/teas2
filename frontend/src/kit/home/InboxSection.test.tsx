import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { setSettings } from '@/mocks/settings';
import { loadState, resetState } from '@/mocks/store';
import { testServer } from '@/mocks/test-server';
import { ApprovalsSection } from './InboxSection';

vi.mock('next/navigation', () => import('@/test/next-navigation'));
beforeAll(() => testServer.listen({ onUnhandledFrame: 'bypass' }));
afterEach(() => { cleanup(); testServer.resetHandlers(); });
afterAll(() => testServer.close());
beforeEach(() => { localStorage.clear(); resetState(); setSettings({ companyKey: 'vat', role: 'accountant', screenState: 'normal' }); });

Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => {};
Element.prototype.releasePointerCapture ??= () => {};
Element.prototype.scrollIntoView ??= () => {};

const pending = () => loadState().docs.filter((d) => d.companyId === 'co-vat' && d.status === 'pending');
function open() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <TooltipProvider><ApprovalsSection /></TooltipProvider>
    </QueryClientProvider>,
  );
}

describe('the approval inbox on Home', () => {
  it('lists a pending claim with its requester and age, and approve-and-issue from Home issues it once (one number) and the row goes', async () => {
    const ex = pending()[0];
    expect(ex).toBeDefined();
    open();
    const row = await screen.findByTestId(`inbox-${ex.id}`);
    expect(within(row).getByText(new RegExp(ex.approval!.submittedBy.name))).toBeVisible();
    await userEvent.click(within(row).getByRole('button', { name: /^อนุมัติและออก/ }));
    await waitFor(() => expect(loadState().docs.find((d) => d.id === ex.id)!.status).toBe('issued'));
    const issued = loadState().docs.find((d) => d.id === ex.id)!;
    expect(issued.number).toMatch(/^EX-/);
    expect(loadState().docs.filter((d) => d.number === issued.number)).toHaveLength(1);
    await waitFor(() => expect(screen.queryByTestId(`inbox-${ex.id}`)).toBeNull());
  });
  it('send back needs a reason and returns the document to a draft', async () => {
    const ex = pending()[0];
    open();
    const row = await screen.findByTestId(`inbox-${ex.id}`);
    await userEvent.click(within(row).getByRole('button', { name: /^ส่งกลับแก้ไข/ }));
    const dlg = await screen.findByRole('alertdialog');
    const confirm = within(dlg).getAllByRole('button').at(-1)!;
    expect(confirm).toBeDisabled();
    await userEvent.type(within(dlg).getByRole('textbox'), 'ใบเสร็จไม่ชัด');
    await userEvent.click(confirm);
    await waitFor(() => expect(loadState().docs.find((d) => d.id === ex.id)!.status).toBe('draft'));
    await waitFor(() => expect(screen.queryByTestId(`inbox-${ex.id}`)).toBeNull());
  });
});
