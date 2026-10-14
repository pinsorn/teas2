import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fixtureIds } from '@/mocks/fixtures/ids';
import { setSettings } from '@/mocks/settings';
import { loadState, resetState } from '@/mocks/store';
import { testServer } from '@/mocks/test-server';
import { Breadcrumbs } from './Breadcrumbs';

let path = '/sales/tax-invoices/%zz';
vi.mock('next/navigation', () => ({ usePathname: () => path }));
beforeAll(() => testServer.listen({ onUnhandledFrame: 'error' }));
afterEach(() => testServer.resetHandlers());
afterAll(() => testServer.close());
beforeEach(() => { localStorage.clear(); resetState(); setSettings({ companyKey: 'vat', role: 'accountant', screenState: 'normal' }); });

const ui = () => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><Breadcrumbs /></QueryClientProvider>);
const crumbs = () => screen.getByRole('navigation', { name: 'breadcrumb' });

describe('Breadcrumbs', () => {
  it('a malformed percent-escape in the path does not throw; no raw segment is shown as a document', async () => {
    path = '/sales/tax-invoices/%zz';
    ui();
    expect(crumbs()).toBeInTheDocument();
    expect(screen.queryByText('%zz')).toBeNull(); // the id is never shown
  });
  it('an issued document shows its number, never its id', async () => {
    const st = loadState(); const id = fixtureIds(st).tiIssuedUnpaid; path = `/sales/tax-invoices/${id}`;
    ui();
    const number = st.docs.find((d) => d.id === id)!.number!;
    expect(await screen.findByText(number)).toBeInTheDocument();
    expect(crumbs()).not.toHaveTextContent(id);
  });
  it('a draft shows "ร่าง"; the edit segment is labelled แก้ไข', async () => {
    const id = fixtureIds(loadState()).tiDraft; path = `/sales/tax-invoices/${id}/edit`;
    ui();
    expect(await screen.findByText('ร่าง')).toBeInTheDocument();
    expect(screen.getByText('แก้ไข')).toBeInTheDocument();
    expect(crumbs()).not.toHaveTextContent(id);
  });
});
