import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { MockToolbar } from './MockToolbar';
import { useRouter } from 'next/navigation';
import { getSettings } from './settings';
import { loadState, resetState, saveState } from './store';

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

describe('MockToolbar refresh and reset (T6)', () => {
  it('changing a setting refreshes the router and refetches active queries', async () => {
    const qc = new QueryClient();
    let n = 0;
    function Probe() { useQuery({ queryKey: ['probe'], queryFn: async () => ++n, staleTime: Infinity }); return null; }
    render(<QueryClientProvider client={qc}><Probe /><MockToolbar defaultOpen /></QueryClientProvider>);
    await waitFor(() => expect(n).toBe(1));
    const refresh = vi.mocked(useRouter().refresh);
    refresh.mockClear();
    await userEvent.selectOptions(screen.getByLabelText('บทบาท'), 'operator');
    expect(getSettings().role).toBe('operator');
    expect(refresh).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(n).toBe(2)); // invalidate refetched the active query
  });
  it('reset restores the seed, refreshes the router and refetches', async () => {
    resetState();
    const seeded = loadState().docs.length;
    const st = loadState();
    st.docs.pop();
    saveState(st);
    expect(loadState().docs.length).toBe(seeded - 1);
    const qc = new QueryClient();
    let n = 0;
    function Probe() { useQuery({ queryKey: ['probe'], queryFn: async () => ++n, staleTime: Infinity }); return null; }
    render(<QueryClientProvider client={qc}><Probe /><MockToolbar defaultOpen /></QueryClientProvider>);
    await waitFor(() => expect(n).toBe(1));
    const refresh = vi.mocked(useRouter().refresh);
    refresh.mockClear();
    await userEvent.click(screen.getByRole('button', { name: 'รีเซ็ตข้อมูลตัวอย่าง' }));
    expect(loadState().docs.length).toBe(seeded);
    expect(refresh).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(n).toBe(2));
  });
});
