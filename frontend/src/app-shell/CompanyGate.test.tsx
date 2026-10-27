import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Me } from '@/domain/types';
import { qk } from '@/lib/query/keys';
import { CompanyGate } from './CompanyGate';

const replace = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace }) }));

const base: Me = { userId: 'u-1', displayName: 'x', memberships: [], activeCompanyId: null, vatRegistered: false, permissions: [], businessDate: '2026-01-01' };
const ui = (me: Me) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(qk.me(), me);
  render(<QueryClientProvider client={qc}><CompanyGate><div>company screen</div></CompanyGate></QueryClientProvider>);
};

describe('CompanyGate', () => {
  it('a Me with activeCompanyId null goes to /onboarding and mounts no company screen', () => {
    replace.mockClear();
    ui(base);
    expect(replace).toHaveBeenCalledWith('/onboarding');
    expect(screen.queryByText('company screen')).toBeNull();
  });
  it('a Me with a company mounts the screen and does not redirect', () => {
    replace.mockClear();
    ui({ ...base, activeCompanyId: 'co-1' });
    expect(screen.getByText('company screen')).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });
});
