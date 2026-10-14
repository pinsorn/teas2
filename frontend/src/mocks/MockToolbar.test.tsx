import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { MockToolbar } from './MockToolbar';
import { getSettings } from './settings';

vi.mock('next/navigation', () => import('@/test/next-navigation'));

describe('MockToolbar', () => {
  it('switching company stores it and invalidates every query', async () => {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, 'invalidateQueries');
    render(<QueryClientProvider client={qc}><MockToolbar defaultOpen /></QueryClientProvider>);
    await userEvent.selectOptions(screen.getByLabelText('บริษัท'), 'nonvat');
    expect(getSettings().companyKey).toBe('nonvat');
    expect(spy).toHaveBeenCalled();
  });
});
