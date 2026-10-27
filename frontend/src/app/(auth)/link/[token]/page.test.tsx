import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setSettings } from '@/mocks/settings';
import { resetState } from '@/mocks/store';
import { testServer } from '@/mocks/test-server';
import SetPasswordPage from './page';

const token = vi.hoisted(() => ({ value: 'x' }));
vi.mock('next/navigation', () => ({ useParams: () => ({ token: token.value }) }));
beforeAll(() => testServer.listen({ onUnhandledFrame: 'error' }));
afterEach(() => { cleanup(); testServer.resetHandlers(); });
afterAll(() => testServer.close());
beforeEach(() => { localStorage.clear(); resetState(); setSettings({ companyKey: 'vat', role: 'accountant', screenState: 'normal' }); });

const show = (t: string) => { token.value = t; return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><SetPasswordPage /></QueryClientProvider>); };
const ONE_MESSAGE = 'ลิงก์นี้ใช้ไม่ได้แล้วหรือหมดอายุ ขอลิงก์ใหม่จากผู้ดูแลระบบ';

describe('set-password page (Q4)', () => {
  it('an unknown link shows the one Thai message and no form', async () => {
    show('this-link-is-used');
    expect(await screen.findByTestId('link-invalid')).toHaveTextContent(ONE_MESSAGE);
    expect(screen.queryByLabelText('รหัสผ่านใหม่')).toBeNull();
  });
  it('an invite link names the account and the company, refuses a weak password with the server message, then confirms', async () => {
    show('inv-5c1e8a3f7b2d4690');
    expect(await screen.findByText(/newcomer@maliwan\.example/)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('รหัสผ่านใหม่'), 'weak');
    await userEvent.type(screen.getByLabelText('ยืนยันรหัสผ่านใหม่'), 'weak');
    await userEvent.click(screen.getByRole('button', { name: 'ตั้งรหัสผ่าน' }));
    expect(await screen.findByTestId('link-error')).toHaveTextContent('อย่างน้อย 10 ตัวอักษร');
    await userEvent.clear(screen.getByLabelText('รหัสผ่านใหม่'));
    await userEvent.clear(screen.getByLabelText('ยืนยันรหัสผ่านใหม่'));
    await userEvent.type(screen.getByLabelText('รหัสผ่านใหม่'), 'Strong#Pass2026');
    await userEvent.type(screen.getByLabelText('ยืนยันรหัสผ่านใหม่'), 'Strong#Pass2026');
    await userEvent.click(screen.getByRole('button', { name: 'ตั้งรหัสผ่าน' }));
    await waitFor(() => expect(screen.getByTestId('link-done')).toBeInTheDocument());
    expect(screen.getByRole('link', { name: 'ไปหน้าเข้าสู่ระบบ' })).toHaveAttribute('href', '/login');
  });
  it('a reset link says so', async () => {
    show('rst-9d4b2f6a1c7e3850');
    expect(await screen.findByRole('heading', { level: 1, name: 'ตั้งรหัสผ่านใหม่' })).toBeInTheDocument();
  });
  it('a server failure is an error state with retry, not the invalid-link message', async () => {
    setSettings({ screenState: 'error' }); // /auth/links is session-less, so force the failure with a mismatched handler
    const { http, HttpResponse } = await import('msw');
    testServer.use(http.get('*/bff/v1/auth/links/:token', () => HttpResponse.json({ code: 'http.500', title: 'ระบบขัดข้อง', status: 500 }, { status: 500 })));
    show('inv-5c1e8a3f7b2d4690');
    expect(await screen.findByText('ระบบขัดข้อง')).toBeInTheDocument();
    expect(screen.queryByTestId('link-invalid')).toBeNull();
    expect(screen.getByRole('button', { name: /ลองใหม่/ })).toBeInTheDocument();
  });
  it('an invite of an existing account has no password form: sign in first', async () => {
    show('inv-8b2e4d6f1a3c7095');
    expect(await screen.findByRole('heading', { level: 1, name: 'เข้าสู่ระบบเพื่อรับคำเชิญ' })).toBeInTheDocument();
    expect(screen.queryByLabelText('รหัสผ่านใหม่')).toBeNull();
    expect(await screen.findByTestId('link-signin')).toHaveAttribute('href', '/login');
  });
  it('the owner of the existing account, signed in, accepts with one click', async () => {
    setSettings({ companyKey: 'nonvat', role: 'admin' });
    const post = (path: string, body: unknown) => fetch(new URL(`/bff/v1${path}`, window.location.origin), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
    const made = await post('/settings/users', { name: 'ผู้รับเชิญ', email: 'somsri@maliwan.example', roleId: 'operator' }) as { link: string };
    await post('/auth/login', { email: 'somsri@maliwan.example', password: 'Somsri#2026ok' });
    show(made.link.split('/link/')[1]!);
    await userEvent.click(await screen.findByTestId('link-accept'));
    expect(await screen.findByTestId('link-done')).toHaveTextContent('รับคำเชิญเรียบร้อยแล้ว');
  });
  it('the success state wins over a later refetch (a used link answers 404)', async () => {
    show('inv-5c1e8a3f7b2d4690');
    await screen.findByLabelText('รหัสผ่านใหม่');
    await userEvent.type(screen.getByLabelText('รหัสผ่านใหม่'), 'Strong#Pass2026');
    await userEvent.type(screen.getByLabelText('ยืนยันรหัสผ่านใหม่'), 'Strong#Pass2026');
    const { http, HttpResponse } = await import('msw');
    testServer.use(http.get('*/bff/v1/auth/links/:token', () => HttpResponse.json({ code: 'auth.link_invalid', title: 'x', status: 404 }, { status: 404 })));
    await userEvent.click(screen.getByRole('button', { name: 'ตั้งรหัสผ่าน' }));
    await screen.findByTestId('link-done');
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
    await new Promise((r) => setTimeout(r, 200));
    expect(screen.getByTestId('link-done')).toBeInTheDocument();
    expect(screen.queryByTestId('link-invalid')).toBeNull();
  });
  it('is never indexed and sends no referrer', async () => {
    show('inv-5c1e8a3f7b2d4690');
    await screen.findByLabelText('รหัสผ่านใหม่');
    expect(document.querySelector('meta[name="robots"]')).toHaveAttribute('content', 'noindex, nofollow');
    expect(document.querySelector('meta[name="referrer"]')).toHaveAttribute('content', 'no-referrer');
  });
});
