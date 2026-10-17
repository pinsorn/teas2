import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type { DocLine } from '@/domain/types';
import { endpoints } from '@/lib/api/endpoints';
import { importStatement, utf8Base64 } from '@/mocks/engine/bank-import';
import { createDraft, issue } from '@/mocks/engine/commands';
import { kbizCsv } from '@/mocks/fixtures/statements/kbiz-2026-10.csv';
import { KBANK_ACCOUNT_NO, KBANK_SEP_CLOSING, withBalances } from '@/mocks/fixtures/statements/kplus-2026-09';
import { USER } from '@/mocks/fixtures/documents';
import { setSettings } from '@/mocks/settings';
import { loadState, resetState, saveState } from '@/mocks/store';
import { testServer } from '@/mocks/test-server';
import { __setSearch } from '@/test/next-navigation';
import type { FilingForm } from '@/domain/filings';
import { FilingView } from './FilingView';
import { FinalizeDialog } from './FinalizeDialog';

vi.mock('next/navigation', () => import('@/test/next-navigation'));
beforeAll(() => testServer.listen({ onUnhandledFrame: 'error' }));
afterAll(() => testServer.close());
afterEach(() => { testServer.resetHandlers(); vi.restoreAllMocks(); });
beforeEach(() => { localStorage.clear(); setSettings({ companyKey: 'vat', role: 'accountant', screenState: 'normal' }); resetState(); __setSearch(''); });
const ui = (form: FilingForm = 'PP30') => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><FilingView form={form} periodKind="month" /></QueryClientProvider>);
};

it('a month with blockers disables finalize and names the first blocker, with a link to fix it', async () => {
  __setSearch('period=2026-10');
  ui();
  const btn = await screen.findByRole('button', { name: /ยืนยันยื่นแบบ/ });
  expect((btn as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByTestId('finalize-why')).toHaveTextContent('ยืนยันไม่ได้:');
  expect(screen.getByTestId('finalize-why')).toHaveTextContent('ฉบับร่าง');
  expect(screen.getByTestId('blockers').querySelector('a')?.getAttribute('href')).toMatch(/\/edit$/);
});

it('a finalizable month confirms through the dialog (totals shown), then reads as filed with the read-only banner and the RD Prep file', async () => {
  __setSearch('period=2026-09');
  ui();
  const btn = await screen.findByRole('button', { name: /ยืนยันยื่นแบบ/ });
  expect((btn as HTMLButtonElement).disabled).toBe(false);
  await userEvent.click(btn);
  const dialog = await screen.findByRole('alertdialog');
  expect(dialog).toHaveTextContent('แก้ไขตัวเลขไม่ได้');
  expect(dialog).toHaveTextContent('ภาษีขาย (ช่อง 5)');
  await userEvent.click(within(dialog).getByRole('button', { name: /ยืนยันยื่นแบบ/ }));
  expect(await screen.findByTestId('filed-banner')).toHaveTextContent('ยื่นแล้ว');
  expect(screen.getByRole('button', { name: /RD Prep/ })).toBeTruthy();
  expect(screen.queryByRole('button', { name: /ยืนยันยื่นแบบ/ })).toBeNull();
});

it('an operator is forbidden; a server error is an error, never "empty"; the toolbar empty state is empty, never an error', async () => {
  setSettings({ role: 'operator' });
  const a = ui();
  await waitFor(() => expect(a.container.querySelector('[data-screen-state="forbidden"]')).not.toBeNull());
  a.unmount();
  setSettings({ role: 'accountant', screenState: 'error' });
  const b = ui();
  await waitFor(() => expect(b.container.querySelector('[data-screen-state="error"]')).not.toBeNull());
  expect(b.container.querySelector('[data-screen-state="empty"]')).toBeNull();
  b.unmount();
  setSettings({ screenState: 'empty' });
  __setSearch('period=2026-09');
  const c = ui();
  await waitFor(() => expect(c.container.querySelector('[data-screen-state="empty"]')).not.toBeNull());
  expect(c.container.querySelector('[data-screen-state="error"]')).toBeNull();
});

it('a company outside VAT has no ภ.พ.30', async () => {
  setSettings({ companyKey: 'nonvat' });
  const { container } = ui();
  await waitFor(() => expect(container.querySelector('[data-screen-state="not-available"]')).not.toBeNull());
});

it('TX2b: a filed ภ.ง.ด.53 shows the frozen boxes (payees are a count, not baht), its attachment and the RD Prep file', async () => {
  __setSearch('period=2026-09');
  ui('PND53');
  expect(await screen.findByTestId('filed-banner')).toHaveTextContent('ยื่นแล้ว');
  expect(screen.getByRole('heading', { level: 2, name: /ภ\.ง\.ด\.53 เดือน/ })).toBeTruthy();
  expect(screen.getByTestId('box-payees')).toHaveTextContent('1 ราย');
  expect(screen.getByTestId('box-tax')).toHaveTextContent('450.00');
  expect(within(screen.getByTestId('filing-attachment')).getAllByRole('row').length).toBeGreaterThan(1);
  expect(screen.getByRole('button', { name: /RD Prep/ })).toBeTruthy();
});

it('TX2b: the ภ.ง.ด.54 is PDF only (no RD Prep file); a company outside VAT has the withholding returns', async () => {
  setSettings({ companyKey: 'nonvat' });
  __setSearch('period=2026-10');
  const { container } = ui('PND54');
  expect(await screen.findByTestId('filing-view')).toBeTruthy();
  expect(container.querySelector('[data-screen-state="not-available"]')).toBeNull();
  expect(screen.getByRole('button', { name: /พิมพ์แบบ/ })).toBeTruthy();
});

it('TX2b: the ภ.พ.36 confirm needs the acknowledgement ticked, and sends it', async () => {
  const onConfirm = vi.fn();
  render(<FinalizeDialog open form="PP36" month="ก.ย. 2569" boxes={[{ code: 'base', labelTh: 'มูลค่า', amount: '10000.00' }, { code: 'vat', labelTh: 'ภาษี', amount: '700.00' }]} pending={false} error={undefined} onConfirm={onConfirm} onCancel={() => undefined} />);
  const dialog = await screen.findByRole('alertdialog');
  const confirm = within(dialog).getByRole('button', { name: /ยืนยันยื่นแบบ/ }) as HTMLButtonElement;
  expect(confirm.disabled).toBe(true);
  await userEvent.click(within(dialog).getByRole('checkbox'));
  expect(confirm.disabled).toBe(false);
  await userEvent.click(confirm);
  expect(onConfirm).toHaveBeenCalledWith(true);
});

it('F2: the acknowledgement does not survive a close (a reopened dialog starts unticked)', async () => {
  const props = { form: 'PP36' as const, month: 'ก.ย. 2569', boxes: [], pending: false, error: undefined, onConfirm: () => undefined, onCancel: () => undefined };
  const { rerender } = render(<FinalizeDialog open {...props} />);
  await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('checkbox'));
  expect((within(screen.getByRole('alertdialog')).getByRole('checkbox') as HTMLInputElement).getAttribute('aria-checked')).toBe('true');
  rerender(<FinalizeDialog open={false} {...props} />); // the parent closes it after a finalize
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  rerender(<FinalizeDialog open {...props} />);
  expect(within(await screen.findByRole('alertdialog')).getByRole('checkbox').getAttribute('aria-checked')).toBe('false');
});

it('F5: FilingView sends the acknowledgement of a ภ.พ.36 with the finalize request', async () => {
  const st = loadState();
  const line: DocLine = { id: 'a', description: 'บริการ', qty: '1', unit: 'งาน', unitPrice: '357.14', taxCode: 'EX', expenseCategory: 'services', whtTypeCode: 'FOR-SVC', pnd36: true };
  const d = createDraft(st, 'co-vat', 'PV', { header: { partyId: 'pv-12', documentDate: '2026-09-10' }, lines: [line] }, USER, 'ack-ui');
  issue(st, d.id, d.version, USER);
  saveState(st);
  const spy = vi.spyOn(endpoints, 'finalizeFiling');
  __setSearch('period=2026-09');
  ui('PP36');
  await userEvent.click(await screen.findByRole('button', { name: /ยืนยันยื่นแบบ/ }));
  const dialog = await screen.findByRole('alertdialog');
  await userEvent.click(within(dialog).getByRole('checkbox'));
  await userEvent.click(within(dialog).getByRole('button', { name: /ยืนยันยื่นแบบ/ }));
  expect(await screen.findByTestId('filed-banner')).toBeTruthy();
  expect(spy).toHaveBeenCalledWith('PP36', '2026-09', expect.any(Number), true);
});

// ---------------------------------------------------------------- TX2c: paying a finalized return
const withLines = (rows: [string, string, string][]) => {
  const st = loadState();
  const content = utf8Base64(kbizCsv({ accountNo: KBANK_ACCOUNT_NO, accountName: 'บริษัท ตัวอย่าง จำกัด', from: '2026-10-01', opening: KBANK_SEP_CLOSING, lines: withBalances(KBANK_SEP_CLOSING, rows) }));
  const imp = importStatement(st, 'co-vat', 'ba-kbank', { fileName: 'tax.csv', format: 'kbiz-csv', content }, USER);
  const lines = st.bankLines.filter((l) => l.importId === imp.id);
  return { st, lines };
};

it('TX2c: an unpaid return shows what is due and the pay button; no lines on the statement says to import one', async () => {
  const seeded = loadState();
  for (const l of seeded.bankLines) l.status = 'ignored'; // no line left to pay with
  saveState(seeded);
  __setSearch('period=2026-08');
  ui();
  const box = await screen.findByTestId('tax-payment');
  expect(box).toHaveTextContent('7,875.00');
  await userEvent.click(within(box).getByRole('button', { name: 'ชำระภาษี' }));
  expect(await screen.findByTestId('no-lines')).toHaveTextContent('นำเข้ารายการเดินบัญชีก่อน');
  expect(screen.getByTestId('tax-payment-dialog').querySelector('a[href="/finance/bank-accounts"]')).not.toBeNull();
});

it('TX2c: pay from the exact line (the other items row stays empty), then the page reads paid with the date, the line link and the cancel button; cancelling needs a reason', async () => {
  const { st, lines } = withLines([['2026-10-13', 'ชำระภาษี กรมสรรพากร', '-7875.00']]);
  saveState(st);
  __setSearch('period=2026-08');
  ui();
  await userEvent.click(within(await screen.findByTestId('tax-payment')).getByRole('button', { name: 'ชำระภาษี' }));
  const dialog = await screen.findByTestId('tax-payment-dialog');
  expect(await within(dialog).findByText('ยอดตรงกับภาษี')).toBeTruthy();
  await userEvent.click(within(dialog).getByRole('radio', { name: /ชำระภาษี กรมสรรพากร/ }));
  await userEvent.click(within(dialog).getByRole('button', { name: 'ชำระภาษี' }));
  const box = await screen.findByTestId('tax-payment');
  await waitFor(() => expect(box).toHaveTextContent('ชำระแล้ว วันที่'));
  expect(within(box).getByRole('link', { name: 'เปิดรายการเดินบัญชี' }).getAttribute('href')).toBe(`/finance/bank-accounts/ba-kbank?line=${lines[0].id}`);
  expect(screen.getByTestId('history-payment-2026-08')).toHaveTextContent('ชำระแล้ว');
  await userEvent.click(within(box).getByRole('button', { name: 'ยกเลิกการชำระ' }));
  const ask = await screen.findByRole('alertdialog');
  const go = within(ask).getByRole('button', { name: 'ยกเลิกการชำระ' }) as HTMLButtonElement;
  expect(go.disabled).toBe(true);
  await userEvent.type(within(ask).getByRole('textbox'), 'ผิดแบบ');
  await userEvent.click(go);
  await waitFor(() => expect(within(screen.getByTestId('tax-payment')).getByRole('button', { name: 'ชำระภาษี' })).toBeTruthy());
});

it('TX2c: a line that is not the tax shows the server message as it is (the page never sums)', async () => {
  const { st } = withLines([['2026-10-13', 'จ่ายมากไป', '-9000.00']]);
  saveState(st);
  __setSearch('period=2026-08');
  ui();
  await userEvent.click(within(await screen.findByTestId('tax-payment')).getByRole('button', { name: 'ชำระภาษี' }));
  const dialog = await screen.findByTestId('tax-payment-dialog');
  await userEvent.click(await within(dialog).findByRole('radio', { name: /จ่ายมากไป/ }));
  await userEvent.click(within(dialog).getByRole('button', { name: 'ชำระภาษี' }));
  expect(await within(dialog).findByRole('alert')).toHaveTextContent('ยอดภาษี 7,875.00 ไม่เท่ากับยอดรายการเดินบัญชี 9,000.00 บาท');
});

it('TX2c: a return with nothing to pay says so', async () => {
  const st = loadState();
  const f = st.filings.find((x) => x.form === 'PP30' && x.period === '2026-08')!;
  for (const b of f.boxes) if (b.code === '5' || b.code === '8' || b.code === '11') b.amount = '0.00';
  saveState(st);
  __setSearch('period=2026-08');
  ui();
  expect(await screen.findByTestId('tax-payment')).toHaveTextContent('ไม่มียอดภาษีต้องชำระ');
});
