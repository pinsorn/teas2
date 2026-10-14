import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { CommandMenu } from './CommandMenu';

vi.mock('next/navigation', () => import('@/test/next-navigation'));
vi.mock('./useMe', () => ({
  useMe: () => ({ me: { activeCompanyId: 'co-vat', permissions: [], vatRegistered: true }, groups: [] }),
}));
const search = vi.fn();
vi.mock('@/lib/api/endpoints', () => ({ endpoints: { search: (q: string) => search(q) } }));

beforeAll(() => {
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  Element.prototype.scrollIntoView = () => {};
});

const mount = () => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <CommandMenu open onOpenChange={() => {}} />
  </QueryClientProvider>,
);

describe('CommandMenu search states', () => {
  it('a failed search shows the error and never "no results"', async () => {
    search.mockRejectedValue(new Error('boom'));
    mount();
    await userEvent.type(screen.getByRole('combobox'), 'zzz');
    expect(await screen.findByText('ค้นหาไม่สำเร็จ ลองอีกครั้ง')).toBeInTheDocument();
    expect(screen.queryByText('ไม่พบรายการที่ตรงกับคำค้น')).not.toBeInTheDocument();
  });
  it('shows "no results" only after the search succeeded with zero hits (not during the debounce)', async () => {
    search.mockResolvedValue({ items: [] });
    mount();
    await userEvent.type(screen.getByRole('combobox'), 'zzz');
    expect(screen.queryByText('ไม่พบรายการที่ตรงกับคำค้น')).not.toBeInTheDocument();
    expect(await screen.findByText('ไม่พบรายการที่ตรงกับคำค้น')).toBeInTheDocument();
  });
});
