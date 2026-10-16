import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { useState } from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { taxInvoice } from '@/descriptors/tax-invoice';
import type { DocDescriptor } from '@/domain/descriptors';
import type { Allocation, ComputeResult, Me } from '@/domain/types';
import { qk } from '@/lib/query/keys';
import { fixtureIds } from '@/mocks/fixtures/ids';
import { setSettings } from '@/mocks/settings';
import { loadState, resetState } from '@/mocks/store';
import { testServer } from '@/mocks/test-server';
import { SettlementPanel } from './SettlementPanel';

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

/** RC stub: the panel only reads `type` and `settles`. */
const receipt = { ...taxInvoice, type: 'RC', settles: ['TI', 'IV'] } as DocDescriptor;
const rc = (id = fixtureIds(loadState()).rcTargetsA) => loadState().docs.find((d) => d.id === id)!;

function Host({ partyId = 'pc-01', allocation, readOnly, initial = [], spy }: {
  partyId?: string; allocation?: ComputeResult['allocation']; readOnly?: boolean; initial?: Allocation[]; spy?: (a: Allocation[]) => void;
}) {
  const [value, setValue] = useState<Allocation[]>(initial);
  return <SettlementPanel descriptor={receipt} partyId={partyId} value={value} allocation={allocation} readOnly={readOnly} onChange={(a) => { setValue(a); spy?.(a); }} />;
}
const mount = (ui: React.ReactElement, qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })) =>
  ({ qc, ...render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>) });

describe('SettlementPanel', () => {
  it('lists the party open items with outstanding and prefills amount = outstanding when ticked (copy of a server string)', async () => {
    const a = rc();
    const spy = vi.fn();
    mount(<Host spy={spy} />);
    const box = await screen.findByRole('checkbox', { name: `เลือก ${a.number}` });
    const row = box.closest('tr')!;
    expect(row).toHaveTextContent(/1,070\.00/); // total and outstanding, formatted from the server strings
    expect(calls).toContain('GET /bff/v1/docs/open-items?partyId=pc-01&types=TI%2CIV');
    await userEvent.click(box);
    expect(spy).toHaveBeenLastCalledWith([{ targetId: a.id, targetType: 'TI', targetNumber: a.number, amount: a.outstanding }]);
    expect(within(row).getByRole('textbox', { name: `จำนวนรับชำระ ${a.number}` })).toHaveValue(a.outstanding);
    await userEvent.click(box);
    expect(spy).toHaveBeenLastCalledWith([]);
  });

  it('shows allocated / unallocated from the compute response, never sums in the client', async () => {
    const a = rc();
    const allocation = { allocated: '1500.00', unallocated: '250.00', suggestedWht: [] };
    mount(<Host initial={[{ targetId: a.id, targetType: 'TI', targetNumber: a.number, amount: '1070.00' }]} allocation={allocation} />);
    await screen.findByRole('checkbox', { name: `เลือก ${a.number}` });
    const status = screen.getAllByRole('status').find((s) => /จัดสรรแล้ว/.test(s.textContent ?? ''))!;
    expect(status).toHaveTextContent('1,500.00'); // the server's figure, although the one ticked row says 1,070.00
    expect(status).toHaveTextContent('250.00');
    expect(status).not.toHaveTextContent(/\b1,070\.00/);
  });

  it('error loading open items shows ErrorState, not "ไม่มีรายการค้างชำระ"', async () => {
    testServer.use(http.get('*/bff/v1/docs/open-items', () => HttpResponse.json({ status: 500, code: 'mock.server_error', title: 'ระบบขัดข้องชั่วคราว' }, { status: 500, headers: { 'content-type': 'application/problem+json' } })));
    const { container } = mount(<Host />);
    expect(await screen.findByText('ระบบขัดข้องชั่วคราว')).toBeVisible();
    expect(container.querySelector('[data-screen-state="error"]')).not.toBeNull();
    expect(screen.queryByText('ไม่มีรายการค้างชำระ')).toBeNull();
    expect(screen.getByRole('button', { name: 'ลองใหม่' })).toBeVisible();
  });

  it('an empty answer says so (and offers no row); a party-less panel asks for the party first', async () => {
    const empty = mount(<Host partyId="pv-01" />); // a vendor owes us no invoice
    expect(await screen.findByText('ไม่มีรายการค้างชำระ')).toBeVisible();
    empty.unmount();
    mount(<Host partyId="" />);
    expect(screen.getByText('เลือกคู่ค้าเพื่อดูรายการที่ค้างชำระ')).toBeVisible();
    expect(calls.filter((c) => c.includes('open-items'))).toHaveLength(1); // the party-less panel never asks
  });

  it('403 names the missing permission (forbidden state), not an empty list', async () => {
    setSettings({ role: 'admin' });
    const { container } = mount(<Host />);
    await waitFor(() => expect(container.querySelector('[data-screen-state="forbidden"]')).not.toBeNull());
    expect(container.textContent).toContain('doc.TI.read');
    expect(screen.queryByText('ไม่มีรายการค้างชำระ')).toBeNull();
  });

  it('re-mounts empty on company switch: the other company items never show and the list is fetched again for the new company', async () => {
    const a = rc();
    const { qc } = mount(<Host />);
    await screen.findByRole('checkbox', { name: `เลือก ${a.number}` });
    const me = qc.getQueryData<Me>(qk.me())!;
    calls.length = 0;
    setSettings({ companyKey: 'nonvat' });
    act(() => { qc.setQueryData(qk.me(), { ...me, activeCompanyId: 'co-nonvat', vatRegistered: false }); });
    expect(await screen.findByText('ไม่มีรายการค้างชำระ')).toBeVisible();
    expect(screen.queryByText(a.number!)).toBeNull();
    expect(calls.filter((c) => c.includes('open-items'))).toHaveLength(1);
    expect(qc.getQueryData(qk.openItems('co-vat', 'pc-01', 'TI,IV'))).toBeTruthy(); // company A's cache entry is separate, never read for B
  });

  it('with the receipt WHT column: types the customer figure, offers the server suggestion as a copy, and the certificate number appears with a WHT', async () => {
    const a = rc();
    const spy = vi.fn();
    const allocation = { allocated: '1070.00', unallocated: '0.00', suggestedWht: [{ targetId: a.id, wht: '30.00', whtTypeCode: 'SVC' }] };
    mount(<Host spy={spy} initial={[{ targetId: a.id, targetType: 'TI', targetNumber: a.number, amount: a.outstanding! }]} allocation={allocation} />);
    await screen.findByRole('checkbox', { name: `เลือก ${a.number}` });
    await userEvent.click(screen.getByRole('button', { name: 'ใช้ยอดที่ระบบแนะนำ 30.00' }));
    expect(spy).toHaveBeenLastCalledWith([expect.objectContaining({ wht: '30.00', whtTypeCode: 'SVC' })]);
    const wht = screen.getByRole('textbox', { name: `ภาษีถูกหัก ณ ที่จ่ายของ ${a.number}` });
    expect(wht).toHaveValue('30.00');
    await userEvent.clear(wht);
    await userEvent.type(wht, '28.5');
    await userEvent.tab();
    expect(wht).toHaveValue('28.50');
    await userEvent.type(screen.getByRole('textbox', { name: `เลขที่หนังสือรับรองของ ${a.number}` }), 'ท.2569/0451');
    expect(spy).toHaveBeenLastCalledWith([expect.objectContaining({ wht: '28.50', certNumber: 'ท.2569/0451' })]);
  });

  it('FN3: a party with an unapplied deposit sees it as a credit, with the server amount and the way to apply it; a party without one sees nothing', async () => {
    mount(<Host partyId="pc-08" />);
    const note = await screen.findByTestId('deposit-credits');
    expect(note).toHaveTextContent(/5,000.00/);
    expect(within(note).getByRole('link')).toHaveAttribute('href', '/finance/deposits');
    expect(calls).toContain('GET /bff/v1/finance/deposits');
    cleanup();
    mount(<Host partyId="pc-01" />);
    await screen.findByRole('checkbox', { name: `เลือก ${rc().number}` });
    expect(screen.queryByTestId('deposit-credits')).toBeNull();
  });

  it('read-only lists the allocations without asking the server and without inputs', () => {
    const a = rc();
    mount(<Host readOnly initial={[{ targetId: a.id, targetType: 'TI', targetNumber: a.number, amount: '1000.00', wht: '30.00' }]} />);
    expect(screen.getByText(a.number!)).toBeVisible();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(calls.filter((c) => c.includes('open-items'))).toEqual([]);
  });
});
