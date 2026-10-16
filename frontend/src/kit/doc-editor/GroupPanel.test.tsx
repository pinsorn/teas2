import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { useState } from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { billingStatement } from '@/descriptors/billing-statement';
import type { Allocation } from '@/domain/types';
import { setSettings } from '@/mocks/settings';
import { loadState, resetState } from '@/mocks/store';
import { testServer } from '@/mocks/test-server';
import { GroupPanel } from './GroupPanel';

vi.mock('next/navigation', () => import('@/test/next-navigation'));
beforeAll(() => testServer.listen({ onUnhandledFrame: 'error' }));
afterEach(() => { cleanup(); testServer.resetHandlers(); testServer.events.removeAllListeners(); });
afterAll(() => testServer.close());
const calls: string[] = [];
beforeEach(() => {
  localStorage.clear(); resetState(); calls.length = 0;
  setSettings({ companyKey: 'vat', role: 'accountant', screenState: 'normal' });
  testServer.events.on('request:start', ({ request }) => calls.push(`${request.method} ${new URL(request.url).pathname}${new URL(request.url).search}`));
});

function Host({ partyId = 'pc-01', total, readOnly, initial = [], spy }: { partyId?: string; total?: string; readOnly?: boolean; initial?: Allocation[]; spy?: (a: Allocation[]) => void }) {
  const [value, setValue] = useState<Allocation[]>(initial);
  return <GroupPanel descriptor={billingStatement} partyId={partyId} value={value} total={total} readOnly={readOnly} onChange={(a) => { setValue(a); spy?.(a); }} />;
}
const mount = (ui: React.ReactElement) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>);
const ti = (id: string) => loadState().docs.find((d) => d.id === id)!;

describe('GroupPanel', () => {
  it('lists only the party\'s open TI / IV (the types of the company), ticking copies the server\'s outstanding and never computes one', async () => {
    const spy = vi.fn();
    mount(<Host spy={spy} />);
    const a = ti('ti-057');
    const box = await screen.findByRole('checkbox', { name: `เลือก ${a.number}` });
    expect(calls).toContain('GET /bff/v1/docs/open-items?partyId=pc-01&types=TI'); // IV is not a type of a VAT company
    expect(box.closest('tr')).toHaveTextContent('64,200.00');
    expect(screen.queryByRole('checkbox', { name: /^เลือก IV-/ })).toBeNull();
    await userEvent.click(box);
    expect(spy).toHaveBeenLastCalledWith([{ targetId: a.id, targetType: 'TI', targetNumber: a.number, amount: a.outstanding }]);
    await userEvent.click(box);
    expect(spy).toHaveBeenLastCalledWith([]);
  });

  it('shows the total the server computed for the current list, not the sum of the ticked rows', async () => {
    const a = ti('ti-057'), b = ti('spike-60');
    mount(<Host total="123.45" initial={[{ targetId: a.id, targetType: 'TI', amount: a.outstanding! }, { targetId: b.id, targetType: 'TI', amount: b.outstanding! }]} />);
    await screen.findByRole('checkbox', { name: `เลือก ${a.number}` });
    const status = screen.getAllByRole('status').find((s) => /ยอดรวมใบวางบิล/.test(s.textContent ?? ''))!;
    expect(status).toHaveTextContent('123.45'); // the rows say 64,200.00 and 762,375.00
    expect(status).not.toHaveTextContent('826,575.00');
  });

  it('a non-VAT company lists its IV, another party\'s are not offered, and a party-less panel asks for the party', async () => {
    setSettings({ companyKey: 'nonvat', role: 'accountant', screenState: 'normal' });
    resetState();
    const iv = loadState().docs.find((d) => d.id === 'iv-1')!;
    const first = mount(<Host partyId="nc-01" />);
    expect(await screen.findByRole('checkbox', { name: `เลือก ${iv.number}` })).toBeVisible();
    expect(calls).toContain('GET /bff/v1/docs/open-items?partyId=nc-01&types=IV');
    expect(screen.queryByRole('checkbox', { name: `เลือก ${loadState().docs.find((d) => d.id === 'iv-2')!.number}` })).toBeNull(); // iv-2 is nc-03's
    expect(screen.queryByRole('checkbox', { name: `เลือก ${loadState().docs.find((d) => d.id === 'iv-s1')!.number}` })).toBeNull(); // settled: nothing outstanding
    first.unmount();
    mount(<Host partyId="" />);
    expect(await screen.findByText('เลือกคู่ค้าเพื่อดูเอกสารที่วางบิลได้')).toBeVisible();
  });

  it('an error loading shows the error state (not "no documents"); read-only lists the grouped rows with the recorded amounts', async () => {
    testServer.use(http.get('*/bff/v1/docs/open-items', () => HttpResponse.json({ status: 500, code: 'mock.server_error', title: 'ระบบขัดข้องชั่วคราว' }, { status: 500, headers: { 'content-type': 'application/problem+json' } })));
    const { container } = mount(<Host />);
    expect(await screen.findByText('ระบบขัดข้องชั่วคราว')).toBeVisible();
    expect(container.querySelector('[data-screen-state="error"]')).not.toBeNull();
    expect(screen.queryByText('ไม่มีเอกสารค้างชำระที่วางบิลได้')).toBeNull();
    cleanup();
    testServer.resetHandlers();
    const bl = ti('bl-1');
    mount(<Host readOnly total={bl.totals.total} initial={bl.allocations} />);
    const list = within(screen.getByRole('list'));
    expect(list.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByRole('status')).toHaveTextContent(bl.totals.total.replace(/\B(?=(\d{3})+(?!\d))/g, ','));
  });
});
