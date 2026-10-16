import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextIntlClientProvider } from 'next-intl';
import th from '@/messages/th.json';
import type { HeaderFieldKey } from '@/domain/descriptors';
import type { DocHeader } from '@/domain/types';
import { setSettings } from '@/mocks/settings';
import { resetState } from '@/mocks/store';
import { testServer } from '@/mocks/test-server';
import { HeaderFields } from './HeaderFields';

vi.mock('next/navigation', () => import('@/test/next-navigation'));
beforeAll(() => testServer.listen({ onUnhandledFrame: 'error' }));
afterEach(() => { cleanup(); testServer.resetHandlers(); });
afterAll(() => testServer.close());
beforeEach(() => { localStorage.clear(); resetState(); setSettings({ companyKey: 'vat', role: 'accountant', screenState: 'normal' }); });

const KEYS: HeaderFieldKey[] = ['documentDate', 'vendorDocNumber', 'vendorDocDate', 'claimPeriod', 'complete'];
function Host({ initial, spy }: { initial: DocHeader; spy?: (h: DocHeader) => void }) {
  const [h, setH] = useState(initial);
  spy?.(h);
  return <HeaderFields type="PB" keys={KEYS} ids="x" header={h} setHeader={setH} />;
}
const ui = (initial: DocHeader, spy?: (h: DocHeader) => void) => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <NextIntlClientProvider locale="th" messages={th}><Host initial={initial} spy={spy} /></NextIntlClientProvider>
  </QueryClientProvider>);

describe('HeaderFields of a purchase bill', () => {
  it('shows the vendor paperwork, the claim period (the document month until one is chosen) and the completeness box, checked by default', async () => {
    ui({ documentDate: '2026-10-14' });
    expect(screen.getByLabelText('เลขที่เอกสารของผู้ขาย')).toHaveValue('');
    expect(await screen.findByLabelText('งวดที่ขอคืนภาษีซื้อ')).toHaveValue('2026-10');
    expect(screen.getByRole('checkbox', { name: /เอกสารครบ/ })).toBeChecked();
  });
  it('unchecking completeness stores complete=false, checking it again clears the field (absent = complete)', async () => {
    let last: DocHeader | undefined;
    ui({ documentDate: '2026-10-14' }, (h) => { last = h; });
    await userEvent.click(screen.getByRole('checkbox', { name: /เอกสารครบ/ }));
    expect(last!.complete).toBe(false);
    await userEvent.click(screen.getByRole('checkbox', { name: /เอกสารครบ/ }));
    expect(last!.complete).toBeUndefined();
  });
  it('a claim period that was only the document month follows a new date; one the user chose stays', async () => {
    let last: DocHeader | undefined;
    ui({ documentDate: '2026-10-14', claimPeriod: '2026-10' }, (h) => { last = h; });
    await screen.findByLabelText('งวดที่ขอคืนภาษีซื้อ');
    const date = screen.getByLabelText('วันที่เอกสาร');
    await userEvent.clear(date);
    await userEvent.type(date, '2026-11-02');
    expect(last!.claimPeriod).toBeUndefined(); // follows: the server fills the document month at issue
    cleanup();
    ui({ documentDate: '2026-10-14', claimPeriod: '2026-12' }, (h) => { last = h; });
    const d2 = screen.getByLabelText('วันที่เอกสาร');
    await userEvent.clear(d2);
    await userEvent.type(d2, '2026-11-02');
    expect(last!.claimPeriod).toBe('2026-12');
  });
  it('a non-VAT company has no claim period field', async () => {
    setSettings({ companyKey: 'nonvat' });
    ui({ documentDate: '2026-10-14' });
    await screen.findByLabelText('เลขที่เอกสารของผู้ขาย');
    await new Promise((r) => setTimeout(r, 400));
    expect(screen.queryByLabelText('งวดที่ขอคืนภาษีซื้อ')).toBeNull();
  });
});
