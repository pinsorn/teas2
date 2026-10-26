import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { HomeView } from '@/app/(app)/home-view';
import { TooltipProvider } from '@/components/ui/tooltip';
import { HOME_SECTIONS, homeSectionsFor } from '@/domain/home';
import type { Role } from '@/domain/types';
import { endpoints } from '@/lib/api/endpoints';
import { formatTHB } from '@/lib/format';
import { homeKpis } from '@/mocks/engine/home';
import { PERMISSIONS_BY_ROLE } from '@/mocks/permissions';
import { setSettings } from '@/mocks/settings';
import { loadState, resetState, saveState } from '@/mocks/store';
import { testServer } from '@/mocks/test-server';

vi.mock('next/navigation', () => import('@/test/next-navigation'));
beforeAll(() => testServer.listen({ onUnhandledFrame: 'bypass' }));
afterEach(() => { cleanup(); testServer.resetHandlers(); testServer.events.removeAllListeners(); });
afterAll(() => testServer.close());
beforeEach(() => { localStorage.clear(); resetState(); setSettings({ companyKey: 'vat', role: 'accountant', screenState: 'normal' }); });

Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => {};
Element.prototype.releasePointerCapture ??= () => {};
Element.prototype.scrollIntoView ??= () => {};

/** Every Home request the page makes, by section. */
function logHome(): string[] {
  const seen: string[] = [];
  testServer.events.on('request:start', ({ request }) => { const m = /\/bff\/v1\/home\/([a-z]+)/.exec(request.url); if (m) seen.push(m[1]); });
  return seen;
}
function open(role: Role) {
  setSettings({ role });
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <TooltipProvider><HomeView /></TooltipProvider>
    </QueryClientProvider>,
  );
}

describe('role-aware Home: a section the role cannot see is absent AND never queried', () => {
  for (const role of ['operator', 'accountant', 'admin'] as const) {
    it(`${role}: requests exactly the sections its permissions allow`, async () => {
      const seen = logHome();
      open(role);
      const want = homeSectionsFor(PERMISSIONS_BY_ROLE[role]);
      await waitFor(() => expect([...new Set(seen)].sort()).toEqual([...want].sort()), { timeout: 4000 });
      await waitFor(() => expect(document.querySelector('[data-screen-state="loading"]')).toBeNull());
      for (const s of HOME_SECTIONS) expect(document.getElementById(`h-${s}`) !== null, `${role} / ${s}`).toBe(want.includes(s));
      expect(seen.filter((s) => !want.includes(s as never))).toEqual([]);
    });
  }
  it('a role whose only KPI right is tax.read gets no kpis section and no kpis request', async () => {
    const st = loadState();
    st.roles.push({ id: 'r-tax', companyId: 'co-vat', name: 'ภาษีอย่างเดียว', permissions: ['tax.read'], version: 1 });
    st.staff.find((m) => m.companyId === 'co-vat' && m.userId === 'u-1')!.roleId = 'r-tax';
    saveState(st);
    const seen = logHome();
    open('accountant');
    await waitFor(() => expect([...new Set(seen)].sort()).toEqual(homeSectionsFor(['tax.read']).sort()), { timeout: 4000 });
    expect(seen).not.toContain('kpis');
    expect(document.getElementById('h-kpis')).toBeNull();
  });
  it('the roles really differ (the operator has the cash tile only, the accountant the inbox, the admin no inbox)', () => {
    expect(homeSectionsFor(PERMISSIONS_BY_ROLE.operator)).not.toContain('deadlines');
    expect(homeSectionsFor(PERMISSIONS_BY_ROLE.accountant)).toEqual(expect.arrayContaining(['kpis', 'approvals']));
    expect(homeSectionsFor(PERMISSIONS_BY_ROLE.admin)).not.toContain('approvals');
  });
  it('the empty screen state gates the KPI tiles like the real payload (permitted tiles 0.00, the rest null)', async () => {
    setSettings({ role: 'operator', screenState: 'empty' });
    await expect(endpoints.getHome('kpis')).resolves.toEqual({ cash: '0.00', ar: null, ap: null, vatThisMonth: null });
    setSettings({ role: 'accountant', screenState: 'empty' });
    await expect(endpoints.getHome('kpis')).resolves.toMatchObject({ cash: '0.00', ar: '0.00', ap: '0.00' });
  });
  it('the server refuses a section the role cannot see', async () => {
    setSettings({ role: 'operator' });
    await expect(endpoints.getHome('deadlines')).rejects.toMatchObject({ problem: { status: 403 } });
  });
});

describe('each section owns its state', () => {
  it('one failing section shows its own error with retry while the others render', async () => {
    let calls = 0;
    testServer.use(http.get('*/bff/v1/home/drafts', () => (calls++ === 0
      ? HttpResponse.json({ status: 500, code: 'mock.server_error', title: 'ระบบขัดข้องชั่วคราว' }, { status: 500, headers: { 'content-type': 'application/problem+json' } })
      : HttpResponse.json([]))));
    open('accountant');
    const drafts = await screen.findByRole('region', { name: /ฉบับร่างของฉัน/ });
    await waitFor(() => expect(drafts.querySelector('[data-screen-state="error"]')).not.toBeNull());
    const kpi = screen.getByRole('region', { name: 'ภาพรวมการเงิน' });
    await waitFor(() => expect(within(kpi).getByTestId('kpi-ar')).toBeVisible());
    expect(document.querySelectorAll('[data-screen-state="error"]')).toHaveLength(1); // only the failing section
    await userEvent.click(within(drafts).getByRole('button', { name: 'ลองใหม่' }));
    await waitFor(() => expect(drafts.querySelector('[data-screen-state="empty"]')).not.toBeNull());
  });
  it('a company outside VAT has no VAT tile at all (not a zero)', async () => {
    setSettings({ companyKey: 'nonvat' });
    open('accountant');
    await screen.findByTestId('kpi-ar');
    expect(screen.queryByTestId('kpi-vat')).toBeNull();
  });
  it('the KPI tiles show the engine figures', async () => {
    open('accountant');
    const ar = await screen.findByTestId('kpi-ar');
    expect(ar.textContent).toBe(formatTHB(homeKpis(loadState(), 'co-vat', PERMISSIONS_BY_ROLE.accountant).ar!));
  });
});
