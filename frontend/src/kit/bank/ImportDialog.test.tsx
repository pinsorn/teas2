import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { KBIZ_2026_10, KBIZ_OCT_NAME } from '@/mocks/fixtures/statements/kbiz-2026-10.csv';
import { KPLUS_SAMPLE_BASE64, KPLUS_SAMPLE_NAME } from '@/mocks/fixtures/statements/kplus-2026-09';
import { setSettings } from '@/mocks/settings';
import { loadState, resetState } from '@/mocks/store';
import { testServer } from '@/mocks/test-server';
import { ImportDialog } from './ImportDialog';

vi.mock('next/navigation', () => import('@/test/next-navigation'));
beforeAll(() => testServer.listen({ onUnhandledFrame: 'error' }));
afterEach(() => { cleanup(); testServer.resetHandlers(); });
afterAll(() => testServer.close());
beforeEach(() => { localStorage.clear(); resetState(); setSettings({ companyKey: 'vat', role: 'accountant', screenState: 'normal' }); });

const mount = (onClose = vi.fn()) => {
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><ImportDialog accountId="ba-kbank" onClose={onClose} /></QueryClientProvider>);
  return onClose;
};
const FILE_LABEL = /ไฟล์ statement/;
const csv = () => new File([KBIZ_2026_10], KBIZ_OCT_NAME, { type: 'text/csv' });

describe('ImportDialog', () => {
  it('uploads the KBiz CSV and reports how many lines came in and for which period', async () => {
    mount();
    await userEvent.upload(await screen.findByLabelText(FILE_LABEL), csv());
    expect(screen.queryByLabelText(/รหัสผ่านไฟล์ PDF/)).toBeNull(); // a CSV has no password
    await userEvent.click(screen.getByRole('button', { name: 'นำเข้า' }));
    expect(await screen.findByText('นำเข้าสำเร็จ 12 รายการ')).toBeVisible();
    expect(loadState().bankLines.filter((l) => l.accountId === 'ba-kbank')).toHaveLength(18 + 12);
  });

  it('asks for a file first, and refuses an extension it cannot read, without calling the server', async () => {
    const seen = vi.fn();
    testServer.events.on('request:start', ({ request }) => { if (request.method === 'POST') seen(request.url); });
    mount();
    await userEvent.click(await screen.findByRole('button', { name: 'นำเข้า' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('เลือกไฟล์ statement ก่อน');
    await userEvent.upload(screen.getByLabelText(FILE_LABEL), new File(['x'], 'statement.xlsx'), { applyAccept: false });
    await userEvent.click(screen.getByRole('button', { name: 'นำเข้า' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('รองรับเฉพาะไฟล์ .csv หรือ .pdf');
    expect(seen).not.toHaveBeenCalled();
    testServer.events.removeAllListeners();
  });

  it('a PDF shows the password field; the password is sent once and is neither kept in the form nor echoed in an error', async () => {
    const bodies: Record<string, unknown>[] = [];
    testServer.use(http.post('*/bff/v1/finance/bank-accounts/ba-kbank/imports', async ({ request }) => {
      bodies.push((await request.json()) as Record<string, unknown>);
      return HttpResponse.json({ type: 'about:blank', status: 422, code: 'bank.pdf_unreadable', title: 'อ่านไฟล์ PDF ไม่ได้ — ลองไฟล์ CSV จาก K BIZ' }, { status: 422, headers: { 'content-type': 'application/problem+json' } });
    }));
    mount();
    await userEvent.upload(await screen.findByLabelText(FILE_LABEL), new File([atob(KPLUS_SAMPLE_BASE64)], 'other.pdf', { type: 'application/pdf' }));
    const pw = await screen.findByLabelText(/รหัสผ่านไฟล์ PDF/);
    expect(pw).toHaveAttribute('type', 'password');
    await userEvent.type(pw, 'S3cr3t-pw-9');
    await userEvent.click(screen.getByRole('button', { name: 'นำเข้า' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('อ่านไฟล์ PDF ไม่ได้ — ลองไฟล์ CSV จาก K BIZ');
    expect(document.body.textContent).not.toContain('S3cr3t-pw-9');
    expect(bodies[0]).toMatchObject({ fileName: 'other.pdf', format: 'kplus-pdf', password: 'S3cr3t-pw-9' });
    await waitFor(() => expect(screen.getByLabelText(/รหัสผ่านไฟล์ PDF/)).toHaveValue('')); // cleared once sent
    expect(JSON.stringify(localStorage)).not.toContain('S3cr3t-pw-9');
  });

  it('the sample K PLUS PDF imports; a second import of the same period comes back with the overlap warning', async () => {
    mount();
    await userEvent.upload(await screen.findByLabelText(FILE_LABEL), new File([atob(KPLUS_SAMPLE_BASE64)], KPLUS_SAMPLE_NAME, { type: 'application/pdf' }));
    await userEvent.click(screen.getByRole('button', { name: 'นำเข้า' }));
    expect(await screen.findByText('นำเข้าสำเร็จ 18 รายการ')).toBeVisible();
    expect(screen.getByText('คำเตือน')).toBeVisible(); // September is already imported (seed)
    expect(screen.getByText(/ทับซ้อนกับไฟล์ที่นำเข้าแล้ว/)).toBeVisible();
  });
});
