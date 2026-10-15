import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, delay, http } from 'msw';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { taxInvoice } from '@/descriptors/tax-invoice';
import { setSettings } from '@/mocks/settings';
import { resetState } from '@/mocks/store';
import { testServer } from '@/mocks/test-server';
import { vatItems } from '@/mocks/fixtures/items';
import { endpoints } from '@/lib/api/endpoints';
import { qk } from '@/lib/query/keys';
import type { Doc, Me } from '@/domain/types';
import { useRouter } from 'next/navigation';
import { DocEditor } from './DocEditor';

vi.mock('next/navigation', () => import('@/test/next-navigation'));
const calls: string[] = [];
beforeAll(() => testServer.listen({ onUnhandledFrame: 'error' }));
// unmounting a dirty editor flushes it (I2): let that save land before the next test resets the store
afterEach(async () => { cleanup(); await new Promise((r) => setTimeout(r, 150)); testServer.resetHandlers(); testServer.events.removeAllListeners(); });
afterAll(() => testServer.close());
beforeEach(() => {
  localStorage.clear(); resetState(); calls.length = 0;
  setSettings({ companyKey: 'vat', role: 'accountant', screenState: 'normal' });
  testServer.events.on('request:start', ({ request }) => calls.push(`${request.method} ${new URL(request.url).pathname}`));
});

const ui = (onIssued = vi.fn()) => {
  render(<QueryClientProvider client={new QueryClient()}><DocEditor descriptor={taxInvoice} mode="create" onIssued={onIssued} /></QueryClientProvider>);
  return onIssued;
};

describe('DocEditor', () => {
  it('Enter picks the highlighted customer and prefills the usual item', async () => {
    ui();
    await userEvent.type(screen.getByRole('combobox', { name: 'ลูกค้า' }), 'นาวา');
    await userEvent.keyboard('{Enter}');
    expect(await screen.findByText(/0105568024684/)).toBeVisible();
    expect(screen.getByRole('combobox', { name: 'รายการ 1' })).toHaveValue('ออกแบบอัตลักษณ์องค์กร');
  });
  it('Enter while composing text does nothing', async () => {
    ui();
    const box = screen.getByRole('combobox', { name: 'ลูกค้า' });
    await userEvent.type(box, 'นาวา');
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: true }));
    expect(screen.queryByText(/0105568024684/)).toBeNull();
  });
  it('no match keeps the typed text and lists the gap in "ยังขาดอะไร"', async () => {
    ui();
    await userEvent.type(screen.getByRole('combobox', { name: 'ลูกค้า' }), 'ไม่มีชื่อนี้');
    await screen.findByRole('option', { name: /เพิ่มลูกค้า/ }); // the user may add it (party.manage), so Enter would open the form: leave the list instead
    await userEvent.keyboard('{Escape}');
    expect(screen.getByRole('combobox', { name: 'ลูกค้า' })).toHaveValue('ไม่มีชื่อนี้');
    expect(await screen.findByRole('region', { name: 'ยังขาดอะไร' })).toHaveTextContent('เลือกลูกค้า');
  });
  it('quick-create: an unknown customer is added from the editor, picked, and no longer listed as missing', async () => {
    ui();
    const name = 'บริษัท ลูกค้าใหม่ จำกัด';
    await userEvent.type(screen.getByRole('combobox', { name: 'ลูกค้า' }), name);
    await userEvent.click(await screen.findByRole('option', { name: `+ เพิ่มลูกค้า “${name}”` }));
    const dialog = await screen.findByRole('dialog', { name: 'เพิ่มลูกค้า' });
    await waitFor(() => expect(within(dialog).getByLabelText('รหัส')).toHaveValue('C14'));
    await userEvent.type(within(dialog).getByLabelText('เลขประจำตัวผู้เสียภาษี'), '0105500000003');
    await userEvent.click(within(dialog).getByRole('button', { name: 'บันทึก' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('combobox', { name: 'ลูกค้า' })).toHaveValue(name);
    expect(await screen.findByText(/0105500000003/)).toBeVisible();
    await waitFor(() => expect(screen.getByRole('region', { name: 'ยังขาดอะไร' })).not.toHaveTextContent('เลือกลูกค้า'));
    await waitFor(() => expect(calls).toContain('POST /bff/v1/docs/TI/compute'));
  });
  it('quick-create needs party.manage: without it the option is gone and the hint names the permission', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><DocEditor descriptor={taxInvoice} mode="create" onIssued={vi.fn()} /></QueryClientProvider>);
    await waitFor(() => expect(qc.getQueryData(qk.me())).toBeTruthy());
    const me = qc.getQueryData<Me>(qk.me())!;
    act(() => { qc.setQueryData(qk.me(), { ...me, permissions: me.permissions.filter((p) => p !== 'party.manage') }); });
    await userEvent.type(screen.getByRole('combobox', { name: 'ลูกค้า' }), 'ไม่มีชื่อนี้');
    expect((await screen.findAllByText(/ต้องมีสิทธิ์ party.manage/)).length).toBeGreaterThan(0);
    expect(screen.queryByRole('option')).toBeNull();
    await userEvent.keyboard('{Enter}'); // Enter on no match, without the permission, is the old behaviour: the text stays, no form
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('combobox', { name: 'ลูกค้า' })).toHaveValue('ไม่มีชื่อนี้');
    expect(await screen.findByRole('region', { name: 'ยังขาดอะไร' })).toHaveTextContent('เลือกลูกค้า');
  });
  it('a customer document offers sales items only: a purchase item with a similar name is not suggested', async () => {
    ui();
    await userEvent.type(screen.getByRole('combobox', { name: 'รายการ 1' }), 'ถ่ายภาพ');
    const opts = await screen.findAllByRole('option');
    expect(opts.map((o) => o.textContent)).toEqual([expect.stringContaining('SV-04')]); // not EXP-05 "ค่าถ่ายภาพสินค้า"
  });
  it('totals come from the compute endpoint, not the browser', async () => {
    ui();
    await userEvent.type(screen.getByRole('combobox', { name: 'ลูกค้า' }), 'นาวา{Enter}');
    await waitFor(() => expect(calls).toContain('POST /bff/v1/docs/TI/compute'));
    expect(screen.getByRole('region', { name: 'ยอดรวม' })).toHaveTextContent(/บาท/);
  });
  it('autosave creates one draft per editor session and updates it afterwards', async () => {
    ui();
    await userEvent.type(screen.getByRole('combobox', { name: 'ลูกค้า' }), 'นาวา{Enter}');
    await waitFor(() => expect(calls.filter((c) => c === 'POST /bff/v1/docs/TI')).toHaveLength(1), { timeout: 4000 });
    await userEvent.type(screen.getByRole('textbox', { name: 'หมายเหตุ' }), 'ส่งภายในวันศุกร์');
    await waitFor(() => expect(calls.some((c) => c.startsWith('PUT /bff/v1/docs/TI/'))).toBe(true), { timeout: 4000 });
    expect(calls.filter((c) => c === 'POST /bff/v1/docs/TI')).toHaveLength(1);
  }, 12_000); // two 2 s idle windows back to back: the default 5 s leaves ~0.5 s of slack and flaked under load
  it('Ctrl+Enter opens the confirm dialog with totals; Enter issues', async () => {
    const onIssued = ui();
    await userEvent.type(screen.getByRole('combobox', { name: 'ลูกค้า' }), 'นาวา{Enter}');
    await waitFor(() => expect(screen.getByRole('region', { name: 'ยังขาดอะไร' })).toHaveTextContent('ครบแล้ว'));
    await userEvent.keyboard('{Control>}{Enter}{/Control}');
    expect(await screen.findByRole('alertdialog')).toHaveTextContent('รวมทั้งสิ้น');
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(onIssued).toHaveBeenCalledWith(expect.objectContaining({ status: 'issued' })));
  });
  it('the default document date is the server business date, not the browser clock (browser pinned to 2026-10-20), and issuing succeeds', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-20T03:00:00+07:00'));
    try {
      const onIssued = ui();
      const date = await screen.findByDisplayValue('2026-10-14');
      expect(date).toHaveAttribute('type', 'date');
      expect(screen.queryByDisplayValue('2026-10-20')).toBeNull();
      await userEvent.type(screen.getByRole('combobox', { name: 'ลูกค้า' }), 'นาวา{Enter}');
      await waitFor(() => expect(screen.getByRole('region', { name: 'ยังขาดอะไร' })).toHaveTextContent('ครบแล้ว'));
      await userEvent.keyboard('{Control>}{Enter}{/Control}');
      await screen.findByRole('alertdialog');
      await userEvent.keyboard('{Enter}');
      await waitFor(() => expect(onIssued).toHaveBeenCalledWith(expect.objectContaining({ status: 'issued' })));
    } finally { vi.useRealTimers(); }
  });
  it('the business date fills a blank new document once: a cleared date stays empty, names the gap and blocks issuing', async () => {
    ui();
    const date = await screen.findByDisplayValue('2026-10-14');
    await userEvent.clear(date);
    await new Promise((r) => setTimeout(r, 100));
    expect(date).toHaveValue('');
    await userEvent.type(screen.getByRole('combobox', { name: 'ลูกค้า' }), 'นาวา{Enter}');
    expect(await screen.findByRole('region', { name: 'ยังขาดอะไร' })).toHaveTextContent('ต้องระบุวันที่เอกสาร');
    expect(date).toHaveValue('');
    expect(screen.getByRole('button', { name: 'บันทึกและออกใบกำกับภาษี' })).toBeDisabled();
  });
  it('a 409 on save tells the user and keeps their input', async () => {
    testServer.use(http.put('*/bff/v1/docs/TI/:id', () => new Response(JSON.stringify({ title: 'มีคนแก้เอกสารนี้ก่อนคุณ', code: 'doc.version_conflict', status: 409 }), { status: 409, headers: { 'content-type': 'application/problem+json' } })));
    ui();
    await userEvent.type(screen.getByRole('combobox', { name: 'ลูกค้า' }), 'นาวา{Enter}');
    await waitFor(() => expect(calls).toContain('POST /bff/v1/docs/TI'), { timeout: 4000 }); // the first save is a POST after 2 s idle
    await userEvent.type(screen.getByRole('textbox', { name: 'หมายเหตุ' }), 'x');
    expect(await screen.findByText('มีคนแก้เอกสารนี้ก่อนคุณ', {}, { timeout: 4000 })).toBeVisible();
    expect(screen.getByRole('textbox', { name: 'หมายเหตุ' })).toHaveValue('x');
  });

  it('a VAT customer without a tax id shows the server message and blocks issuing', async () => {
    ui();
    await userEvent.type(screen.getByRole('combobox', { name: 'ลูกค้า' }), 'สมบูรณ์{Enter}');
    expect(await screen.findByText('ผู้ซื้อจดทะเบียน VAT ต้องมีเลขผู้เสียภาษีและสาขา', {}, { timeout: 3000 })).toBeVisible();
    expect(screen.getByRole('button', { name: 'บันทึกและออกใบกำกับภาษี' })).toBeDisabled();
    await userEvent.keyboard('{Control>}{Enter}{/Control}');
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
  it('revise mode hands the proposal off instead of issuing', async () => {
    const issued = (await endpoints.listDocs(taxInvoice.type, { status: 'issued', limit: 1 })).items[0];
    const doc = await endpoints.getDoc(taxInvoice.type, issued.id);
    const onRevisionRequested = vi.fn();
    render(<QueryClientProvider client={new QueryClient()}><DocEditor descriptor={taxInvoice} mode="revise" initial={doc} onIssued={vi.fn()} onRevisionRequested={onRevisionRequested} /></QueryClientProvider>);
    const save = await screen.findByRole('button', { name: 'บันทึกการแก้ไข' });
    await waitFor(() => expect(save).toBeEnabled(), { timeout: 3000 });
    await userEvent.click(save);
    expect(onRevisionRequested).toHaveBeenCalledWith(expect.objectContaining({ header: expect.objectContaining({ partyId: doc.header.partyId }), lines: expect.any(Array) }));
    expect(calls.filter((c) => c.startsWith('POST /bff/v1/docs/TI/') && c.endsWith('/issue') || c.startsWith('PUT'))).toHaveLength(0);
  });
});

describe('DocEditor fix round 1', () => {
  it('a create retried after a failed response re-sends the same body and key, then PUTs the newer edits', async () => {
    const posts: { key: string | null; body: string }[] = [];
    testServer.use(http.post('*/bff/v1/docs/TI', async ({ request }) => {
      posts.push({ key: request.headers.get('Idempotency-Key'), body: await request.clone().text() });
      if (posts.length === 1) return new HttpResponse(null, { status: 503 }); // response lost: the client cannot know
    }));
    ui();
    await userEvent.type(screen.getByRole('textbox', { name: 'หมายเหตุ' }), 'a');
    await waitFor(() => expect(posts).toHaveLength(1), { timeout: 4000 });
    await userEvent.type(screen.getByRole('textbox', { name: 'หมายเหตุ' }), 'b');
    await waitFor(() => expect(posts).toHaveLength(2), { timeout: 4000 });
    expect(posts[1]).toEqual(posts[0]);
    await waitFor(() => expect(calls.some((c) => c.startsWith('PUT /bff/v1/docs/TI/'))).toBe(true), { timeout: 4000 });
    expect(screen.getByRole('textbox', { name: 'หมายเหตุ' })).toHaveValue('ab');
  }, 20000);

  it('the form is frozen while a confirmed document is being saved and issued', async () => {
    testServer.use(http.post('*/bff/v1/docs/TI/:id/issue', async () => { await delay(500); }));
    const onIssued = ui();
    await userEvent.type(screen.getByRole('combobox', { name: 'ลูกค้า' }), 'นาวา{Enter}');
    await waitFor(() => expect(screen.getByRole('region', { name: 'ยังขาดอะไร' })).toHaveTextContent('ครบแล้ว'));
    await userEvent.keyboard('{Control>}{Enter}{/Control}');
    await screen.findByRole('alertdialog');
    await userEvent.keyboard('{Enter}');
    expect(screen.getByRole('textbox', { name: 'หมายเหตุ' })).toBeDisabled();
    await waitFor(() => expect(onIssued).toHaveBeenCalled(), { timeout: 4000 });
  });

  it('an older party selection cannot overwrite a newer one after its usual-item lookup', async () => {
    testServer.use(http.get('*/bff/v1/items', async ({ request }) => {
      const q = new URL(request.url).searchParams.get('q') ?? '';
      if (q === 'SV-01') await delay(700);
      return HttpResponse.json({ items: vatItems().filter((i) => !q || i.id === q).map((i) => { const { companyId, ...rest } = i; void companyId; return rest; }) });
    }));
    ui();
    const box = screen.getByRole('combobox', { name: 'ลูกค้า' });
    await userEvent.type(box, 'นาวา{Enter}');
    await waitFor(() => expect(calls).toContain('GET /bff/v1/items')); // A's slow lookup is in flight
    await userEvent.clear(box);
    await userEvent.type(box, 'ปิ่นทอง{Enter}');
    expect(await screen.findByText(/0105565077124/)).toBeVisible();
    await new Promise((r) => setTimeout(r, 1000));
    expect(screen.queryByText(/0105568024684/)).toBeNull();
    expect(box).toHaveValue('บริษัท ปิ่นทองการพิมพ์ จำกัด');
  });

  it('clearing the picker while the first selection is still resolving leaves the party unset', async () => {
    testServer.use(http.get('*/bff/v1/items', async ({ request }) => {
      const q = new URL(request.url).searchParams.get('q') ?? '';
      if (q === 'SV-01') await delay(600);
      return HttpResponse.json({ items: vatItems().filter((i) => !q || i.id === q).map((i) => { const { companyId, ...rest } = i; void companyId; return rest; }) });
    }));
    ui();
    const box = screen.getByRole('combobox', { name: 'ลูกค้า' });
    await userEvent.type(box, 'นาวา{Enter}');
    await waitFor(() => expect(calls).toContain('GET /bff/v1/items'));
    await userEvent.clear(box);
    await new Promise((r) => setTimeout(r, 900));
    expect(screen.queryByText(/0105568024684/)).toBeNull();
    expect(box).toHaveValue('');
    expect(screen.getByRole('combobox', { name: 'รายการ 1' })).toHaveValue('');
    expect(screen.getByLabelText('ครบกำหนดชำระ')).toHaveValue('');
  });

  it('the item field is a real combobox with a listbox, active option and a results announcement', async () => {
    ui();
    const box = screen.getByRole('combobox', { name: 'รายการ 1' });
    await userEvent.type(box, 'ออกแบบ');
    const list = await screen.findByRole('listbox');
    expect(box).toHaveAttribute('aria-expanded', 'true');
    expect(box).toHaveAttribute('aria-controls', list.id);
    expect(box).toHaveAttribute('aria-activedescendant', screen.getAllByRole('option')[0].id);
    expect(screen.getByText(/^พบ \d+ รายการ$/)).toBeInTheDocument();
  });

  it('a failed compute shows an error with retry in the journal drawer, not "no journal entry"', async () => {
    testServer.use(http.post('*/bff/v1/docs/TI/compute', () => HttpResponse.json({ title: 'คำนวณไม่ได้', code: 'http.500' }, { status: 500 })));
    ui();
    await userEvent.click(screen.getByRole('button', { name: 'ดูรายการบัญชี' }));
    const dlg = await screen.findByRole('dialog');
    expect(await within(dlg).findByRole('alert')).toHaveTextContent('คำนวณไม่ได้');
    expect(within(dlg).getByRole('button', { name: 'ลองใหม่' })).toBeVisible();
    expect(within(dlg).queryByText('ยังไม่มีรายการบัญชี')).toBeNull();
  });
});

describe('final review: I2 / I3 / I7', () => {
  it('I2: leaving the editor within the idle window still saves what was typed', async () => {
    const { unmount } = render(<QueryClientProvider client={new QueryClient()}><DocEditor descriptor={taxInvoice} mode="create" onIssued={vi.fn()} /></QueryClientProvider>);
    await userEvent.type(screen.getByRole('textbox', { name: 'หมายเหตุ' }), 'ห้ามหาย');
    expect(calls).not.toContain('POST /bff/v1/docs/TI'); // still inside the 2 s idle window
    unmount();
    await waitFor(() => expect(calls).toContain('POST /bff/v1/docs/TI'), { timeout: 1500 });
  });
  it('I2: the first autosave puts the edit URL in the address bar without a router navigation (no remount)', async () => {
    const replaceState = vi.spyOn(window.history, 'replaceState');
    ui();
    const note = screen.getByRole('textbox', { name: 'หมายเหตุ' });
    await userEvent.type(note, 'a');
    await waitFor(() => expect(calls).toContain('POST /bff/v1/docs/TI'), { timeout: 4000 });
    await waitFor(() => expect(replaceState).toHaveBeenCalledWith(null, '', expect.stringMatching(/^\/sales\/tax-invoices\/[^/]+\/edit$/)));
    expect(useRouter().replace).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox', { name: 'หมายเหตุ' })).toBe(note);
    replaceState.mockRestore();
  });
  it('I2: closing the tab flushes pending input', async () => {
    ui();
    await userEvent.type(screen.getByRole('textbox', { name: 'หมายเหตุ' }), 'x');
    window.dispatchEvent(new Event('beforeunload', { cancelable: true }));
    await waitFor(() => expect(calls).toContain('POST /bff/v1/docs/TI'), { timeout: 1500 });
  });
  it('I3: a copied draft (create mode with initial content) saves and issues like any new draft', async () => {
    const src = await endpoints.getDoc(taxInvoice.type, (await endpoints.listDocs(taxInvoice.type, { status: 'issued', limit: 1 })).items[0].id);
    const copy: Doc = { ...src, id: '', number: undefined, status: 'draft', version: 0, revision: 0, locks: [], issuedAt: undefined, outstanding: undefined,
      header: { ...src.header, dueDate: undefined }, lines: src.lines.map((l) => ({ ...l, id: crypto.randomUUID() })) };
    const onIssued = vi.fn();
    render(<QueryClientProvider client={new QueryClient()}><DocEditor descriptor={taxInvoice} mode="create" initial={copy} onIssued={onIssued} /></QueryClientProvider>);
    await waitFor(() => expect(screen.getByRole('region', { name: 'ยังขาดอะไร' })).toHaveTextContent('ครบแล้ว'));
    await userEvent.click(screen.getByRole('textbox', { name: 'หมายเหตุ' }));
    await userEvent.keyboard('{Control>}{Enter}{/Control}');
    await screen.findByRole('alertdialog');
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(onIssued).toHaveBeenCalledWith(expect.objectContaining({ status: 'issued', number: expect.any(String) })), { timeout: 4000 });
    expect(calls).toContain('POST /bff/v1/docs/TI');
  });
  it('I7: switching company drops the old party and lines and never saves them into the new company', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><DocEditor descriptor={taxInvoice} mode="create" onIssued={vi.fn()} /></QueryClientProvider>);
    await userEvent.type(screen.getByRole('combobox', { name: 'ลูกค้า' }), 'นาวา{Enter}');
    await waitFor(() => expect(qc.getQueryData(qk.me())).toBeTruthy());
    await userEvent.type(screen.getByRole('textbox', { name: 'หมายเหตุ' }), 'ของบริษัท A');
    const me = qc.getQueryData<Me>(qk.me())!;
    calls.length = 0;
    setSettings({ companyKey: 'nonvat' });
    act(() => { qc.setQueryData(qk.me(), { ...me, activeCompanyId: 'co-nonvat', vatRegistered: false }); });
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'ลูกค้า' })).toHaveValue(''));
    expect(screen.getByRole('textbox', { name: 'หมายเหตุ' })).toHaveValue('');
    await new Promise((r) => setTimeout(r, 2600));
    expect(calls.filter((c) => /^(POST|PUT) \/bff\/v1\/docs\/TI(\/|$)/.test(c) && !c.endsWith('/compute'))).toEqual([]);
  }, 15000);
});

describe('D-09 journal drawer needs ledger.read', () => {
  it('without ledger.read the journal button is disabled and names the permission; with it the button is enabled', async () => {
    setSettings({ role: 'operator' });
    ui();
    const off = await screen.findByRole('button', { name: /ต้องมีสิทธิ์ ดูบัญชี/ });
    expect(off).toBeDisabled();
    expect(off).toHaveAccessibleName(/ดูรายการบัญชี.*ledger\.read/);
    cleanup();
    setSettings({ role: 'accountant' });
    ui();
    await waitFor(() => expect(screen.getByRole('button', { name: 'ดูรายการบัญชี' })).toBeEnabled());
  });
});
