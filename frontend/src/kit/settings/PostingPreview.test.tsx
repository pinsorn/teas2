import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setSettings } from '@/mocks/settings';
import { resetState } from '@/mocks/store';
import { testServer } from '@/mocks/test-server';
import { postingApi } from '@/records/posting-rules';
import { PostingPreview } from './PostingPreview';

beforeAll(() => testServer.listen({ onUnhandledFrame: 'error' }));
afterEach(() => { cleanup(); testServer.resetHandlers(); });
afterAll(() => testServer.close());
beforeEach(() => { localStorage.clear(); resetState(); setSettings({ companyKey: 'vat', role: 'accountant', screenState: 'normal' }); });

const ui = () => render(<QueryClientProvider client={new QueryClient()}><PostingPreview /></QueryClientProvider>);
const row = (role: string) => document.querySelector<HTMLElement>(`[data-role="${role}"]`)!;

describe('PostingPreview (the resolution order made visible)', () => {
  it('shows the rule that wins per role, and the item-level rule beats the company default once it exists', async () => {
    const user = userEvent.setup();
    ui();
    await screen.findByRole('option', { name: /SV-02/ });
    await user.selectOptions(screen.getByLabelText('สินค้า/บริการ'), 'SV-02');
    await user.click(screen.getByRole('button', { name: 'ทดสอบ' }));
    await screen.findByTestId('preview-result');
    expect(within(row('Revenue')).getByText('ค่าเริ่มต้นบริษัท')).toBeInTheDocument();
    expect(row('Revenue')).toHaveTextContent('4100');

    await postingApi.create({ level: 'item', key: 'SV-02', role: 'Revenue', accountCode: '4200' });
    await user.click(screen.getByRole('button', { name: 'ทดสอบ' }));
    await waitFor(() => expect(row('Revenue')).toHaveTextContent('สินค้า/บริการ SV-02'));
    expect(row('Revenue')).toHaveTextContent('4200');
    expect(row('AR')).toHaveTextContent('ค่าเริ่มต้นบริษัท'); // other roles keep falling through to the default
    expect(screen.getByTestId('preview-result')).toHaveTextContent('4200'); // and the sample entry posts to it
  });
  it('a purchase type asks for the expense category; an expense claim has no party to pick', async () => {
    const user = userEvent.setup();
    ui();
    expect(screen.queryByLabelText('หมวดค่าใช้จ่าย')).toBeNull();
    await user.selectOptions(screen.getByLabelText('ประเภทเอกสาร'), 'PB');
    await screen.findByRole('option', { name: 'ค่าวัสดุสิ้นเปลือง' });
    await user.selectOptions(screen.getByLabelText('หมวดค่าใช้จ่าย'), 'supplies');
    await user.click(screen.getByRole('button', { name: 'ทดสอบ' }));
    await waitFor(() => expect(row('Expense')).toHaveTextContent('หมวดค่าใช้จ่าย/ประเภทสินทรัพย์ supplies'));
    expect(row('Expense')).toHaveTextContent('5160');
    await user.selectOptions(screen.getByLabelText('ประเภทเอกสาร'), 'EX');
    expect(screen.queryByLabelText('คู่ค้า')).toBeNull();
  });
  it('a sample that is incomplete as a document (a note with no invoice) still previews, with what is missing shown as a notice', async () => {
    const user = userEvent.setup();
    ui();
    await user.selectOptions(screen.getByLabelText('ประเภทเอกสาร'), 'DN');
    await user.click(screen.getByRole('button', { name: 'ทดสอบ' }));
    await screen.findByTestId('preview-result');
    expect(screen.getByRole('status')).toBeInTheDocument();
  });
});
