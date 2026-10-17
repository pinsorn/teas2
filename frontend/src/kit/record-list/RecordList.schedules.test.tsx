import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { __setSearch } from '@/test/next-navigation';
import { setSettings } from '@/mocks/settings';
import { resetState } from '@/mocks/store';
import { testServer } from '@/mocks/test-server';
import { RECORDS } from '@/records';
import { RecordList } from './RecordList';

vi.mock('next/navigation', () => import('@/test/next-navigation'));
beforeAll(() => testServer.listen({ onUnhandledFrame: 'error' }));
afterEach(() => { cleanup(); testServer.resetHandlers(); });
afterAll(() => testServer.close());
beforeEach(() => { __setSearch(''); localStorage.clear(); resetState(); setSettings({ companyKey: 'vat', role: 'accountant', screenState: 'normal' }); });

const mount = () => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><RecordList descriptor={RECORDS.schedule!} /></QueryClientProvider>);

describe('RecordList on the schedules (AC4)', () => {
  it('lists the active schedules linking to their page, with kind, next run and amount; there is no create button (a schedule is made from a document)', async () => {
    mount();
    expect(await screen.findByRole('heading', { level: 1, name: 'รายการซ้ำและตัดจ่าย' })).toBeVisible();
    expect(await screen.findByRole('link', { name: 'เบี้ยประกันอัคคีภัยอาคาร' })).toHaveAttribute('href', '/accounting/schedules/sch-amort');
    expect(screen.getByRole('link', { name: 'ดูแลเว็บไซต์รายเดือน' })).toHaveAttribute('href', '/accounting/schedules/sch-rec-ti');
    expect(screen.getAllByRole('row')).toHaveLength(4); // header + amortisation + two recurring
    expect(screen.getByText('12,000.00')).toBeVisible();
    expect(screen.getAllByText('31 ต.ค. 2569')).toHaveLength(2); // the insurance run and the accrual JV
    expect(screen.queryByRole('button', { name: /เพิ่ม/ })).toBeNull();
  });
});
