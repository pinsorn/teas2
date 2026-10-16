import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Doc } from '@/domain/types';
import { endpoints } from '@/lib/api/endpoints';
import { setSettings } from '@/mocks/settings';
import { resetState } from '@/mocks/store';
import { testServer } from '@/mocks/test-server';
import { ObWizard } from './ObWizard';

vi.mock('next/navigation', () => import('@/test/next-navigation'));
beforeAll(() => testServer.listen({ onUnhandledFrame: 'error' }));
afterEach(async () => { cleanup(); await new Promise((r) => setTimeout(r, 150)); testServer.resetHandlers(); });
afterAll(() => testServer.close());
beforeEach(() => { localStorage.clear(); resetState(); setSettings({ companyKey: 'vat', role: 'accountant', screenState: 'normal' }); });

const draft = (): Promise<Doc> => endpoints.getDoc('OB', 'ob-d1'); // the seeded VAT draft: receivables, a payable, a bank account with a deposit in transit
const ui = (initial: Doc, onIssued = vi.fn()) => {
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><ObWizard mode="edit-draft" initial={initial} onIssued={onIssued} /></QueryClientProvider>);
  return onIssued;
};
const review = () => userEvent.click(screen.getByRole('button', { name: /6 ตรวจสอบและบันทึก/ }));

describe('ObWizard', () => {
  it('walks the steps and the check step states every tie and the 3900 difference (server figures)', async () => {
    ui(await draft());
    expect(screen.getByRole('heading', { name: /ขั้นที่ 1 จาก 6/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /3 ลูกหนี้\/เจ้าหนี้คงค้างรายฉบับ/ }));
    expect(screen.getAllByRole('combobox', { name: /^ประเภทรายการที่/ })).toHaveLength(3);
    await review();
    const plug = await screen.findByTestId('ob-plug', undefined, { timeout: 4000 });
    await waitFor(() => expect(plug).toHaveTextContent('28,500.00'));
    expect(plug).toHaveTextContent('เครดิตส่วนเกินทุนยอดยกมา (3900)');
    for (const key of ['AR', 'AP', 'BANK:1122']) expect(within(screen.getByTestId(`ob-tie-${key}`)).getByText('ตรงกัน')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'รายการบัญชีที่จะลง' })).toHaveTextContent('ผลต่างยกไปส่วนเกินทุนยอดยกมา');
    await waitFor(() => expect(screen.getByRole('button', { name: 'บันทึกยอดยกมา' })).toBeEnabled(), { timeout: 4000 });
  }, 20000);

  it('a statement balance that does not tie is shown with both figures and blocks the save', async () => {
    ui(await draft());
    await userEvent.click(screen.getByRole('button', { name: /2 เงินสดและธนาคาร/ }));
    const statement = screen.getByRole('textbox', { name: 'ยอด statement ของบัญชี 1' });
    await userEvent.clear(statement);
    await userEvent.type(statement, '19000');
    await review();
    const row = await screen.findByTestId('ob-tie-BANK:1122', undefined, { timeout: 4000 });
    await waitFor(() => expect(within(row).getByText('ไม่ตรงกัน')).toBeInTheDocument(), { timeout: 4000 });
    expect(row).toHaveTextContent('21,500.00'); // the trial-balance line
    expect(row).toHaveTextContent('20,500.00'); // statement 19,000.00 + the deposit in transit 1,500.00
    expect(await screen.findByTestId('ob-missing')).toHaveTextContent('ไม่เท่ากับ');
    expect(screen.getByRole('button', { name: 'บันทึกยอดยกมา' })).toBeDisabled();
  }, 20000);

  it('saves and issues the batch', async () => {
    const onIssued = ui(await draft());
    await review();
    const issue = screen.getByRole('button', { name: 'บันทึกยอดยกมา' });
    await waitFor(() => expect(issue).toBeEnabled(), { timeout: 6000 });
    await userEvent.click(issue);
    await waitFor(() => expect(onIssued).toHaveBeenCalledWith(expect.objectContaining({ type: 'OB', status: 'issued', number: expect.stringMatching(/^OB-/) })), { timeout: 6000 });
  }, 20000);
});
