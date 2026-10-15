import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { quotation } from '@/descriptors/quotation';
import { taxInvoice } from '@/descriptors/tax-invoice';
import { savedViewsFor } from '@/kit/pages/columns';
import { endpoints } from '@/lib/api/endpoints';
import { DocEditor } from '../doc-editor/DocEditor';
import { PaperView } from '../paper/PaperView';
import { setSettings } from '@/mocks/settings';
import { loadState, resetState } from '@/mocks/store';
import { testServer } from '@/mocks/test-server';
import th from '@/messages/th.json';
import { useRouter } from 'next/navigation';
import { AgentBanner } from './AgentBanner';
import { AttachmentsPanel } from './AttachmentsPanel';
import { DocView } from './DocView';

vi.mock('next/navigation', () => import('@/test/next-navigation'));
beforeAll(() => testServer.listen({ onUnhandledFrame: 'error' }));
afterEach(async () => { cleanup(); await new Promise((r) => setTimeout(r, 100)); testServer.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => testServer.close());
beforeEach(() => { localStorage.clear(); resetState(); setSettings({ companyKey: 'vat', role: 'accountant', screenState: 'normal' }); });

Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => {};
Element.prototype.releasePointerCapture ??= () => {};
Element.prototype.scrollIntoView ??= () => {};
const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
const wrap = (node: React.ReactNode) => render(<QueryClientProvider client={client()}>{node}</QueryClientProvider>);
const issuedTi = () => loadState().docs.find((d) => d.type === 'TI' && d.status === 'issued')!;
const file = (name: string, type: string, size = 100) => new File([new Uint8Array(size)], name, { type });

describe('AgentBanner', () => {
  const agent = { kind: 'agent' as const, id: 'ag-1', name: 'ผู้ช่วยบัญชี (AI)', ownerName: 'สมศรี บัญชีดี' };
  it('names the agent and its owner on a draft, and links the check report only when there is one', () => {
    const { rerender } = render(<AgentBanner actor={agent} status="draft" />);
    expect(screen.getByTestId('agent-banner')).toHaveTextContent('ร่างโดย ผู้ช่วยบัญชี (AI) ของ สมศรี บัญชีดี');
    expect(screen.queryByRole('link', { name: 'ดูรายงานการตรวจ' })).toBeNull();
    rerender(<AgentBanner actor={agent} status="draft" reportId="rep-9" />);
    expect(screen.getByRole('link', { name: 'ดูรายงานการตรวจ' })).toHaveAttribute('href', expect.stringContaining('rep-9'));
    rerender(<AgentBanner actor={agent} status="issued" />);
    expect(screen.getByTestId('agent-banner')).toHaveTextContent('สร้างโดย ผู้ช่วยบัญชี (AI)');
  });
  it('shows nothing for a person', () => {
    render(<AgentBanner actor={{ kind: 'user', id: 'u', name: 'สมศรี' }} status="draft" />);
    expect(screen.queryByTestId('agent-banner')).toBeNull();
  });
  it('the document view of an agent draft carries the banner; a user\'s document does not', async () => {
    const agentDraft = loadState().docs.find((d) => d.type === 'TI' && d.status === 'draft' && d.createdBy.kind === 'agent')!;
    wrap(<DocView descriptor={taxInvoice} id={agentDraft.id} />);
    expect(await screen.findByTestId('agent-banner')).toHaveTextContent('ร่างโดย');
    cleanup();
    wrap(<DocView descriptor={taxInvoice} id={issuedTi().id} />);
    await screen.findByTestId('doc-number');
    expect(screen.queryByTestId('agent-banner')).toBeNull();
  });
});

describe('saved view "สร้างโดย AI"', () => {
  it('every document type gets the agent view with ?agent=1', () => {
    const t = (k: string) => k.split('.').reduce((o: never, p) => (o as Record<string, never>)[p], th.docList as never) as string;
    const v = savedViewsFor(quotation, t).find((x) => x.key === 'agent')!;
    expect(v.params).toEqual({ agent: '1' });
    expect(savedViewsFor(taxInvoice, t).filter((x) => x.key === 'agent')).toHaveLength(1); // not doubled when the descriptor lists it
  });
});

describe('AttachmentsPanel', () => {
  const panel = (docId: string, issued: boolean, extra: Partial<React.ComponentProps<typeof AttachmentsPanel>> = {}) =>
    wrap(<AttachmentsPanel type="TI" docId={docId} canEdit issued={issued} {...extra} />);

  it('adds a file with its category, lists it, and shows the server refusal for a file that is too large', async () => {
    const d = loadState().docs.find((x) => x.type === 'TI' && x.status === 'draft')!;
    panel(d.id, false);
    expect(await screen.findByText('ยังไม่มีไฟล์แนบ')).toBeVisible();
    await userEvent.upload(screen.getByLabelText('เลือกไฟล์'), file('po.pdf', 'application/pdf'));
    expect(await screen.findByRole('link', { name: 'po.pdf' })).toBeVisible();
    expect(within(screen.getByRole('list')).getByText('อื่น ๆ')).toBeVisible(); // default category
    await userEvent.upload(screen.getByLabelText('เลือกไฟล์'), file('big.pdf', 'application/pdf', 1024 * 1024 + 1));
    expect(await screen.findByRole('alert')).toHaveTextContent('ไฟล์ใหญ่เกิน 1 MB');
    expect(screen.queryByRole('link', { name: 'big.pdf' })).toBeNull();
  });
  it('a type the server does not accept is refused in place', async () => {
    const d = loadState().docs.find((x) => x.type === 'TI' && x.status === 'draft')!;
    panel(d.id, false);
    await userEvent.upload(screen.getByLabelText('เลือกไฟล์'), file('x.gif', 'image/gif'), { applyAccept: false });
    expect(await screen.findByRole('alert')).toHaveTextContent('PDF, PNG, JPEG');
  });
  it('a full browser storage is shown, not swallowed', async () => {
    const d = loadState().docs.find((x) => x.type === 'TI' && x.status === 'draft')!;
    const real = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, k: string, v: string) {
      if (k.startsWith('teas2.mock.att.')) throw new DOMException('full', 'QuotaExceededError');
      return real.call(this, k, v);
    });
    panel(d.id, false);
    await userEvent.upload(screen.getByLabelText('เลือกไฟล์'), file('po.pdf', 'application/pdf'));
    expect(await screen.findByRole('alert')).toHaveTextContent('พื้นที่เก็บไฟล์ตัวอย่างเต็ม');
  });
  it('removing from an issued document asks first (it is audited); a draft file goes at once', async () => {
    const ti = issuedTi();
    await endpoints.addAttachment('TI', ti.id, { category: 'transfer_slip', name: 'slip.png', mime: 'image/png', dataUrl: 'data:image/png;base64,AAAA' });
    panel(ti.id, true);
    await userEvent.click(await screen.findByRole('button', { name: 'ลบไฟล์ slip.png' }));
    const dlg = await screen.findByRole('alertdialog');
    expect(dlg).toHaveTextContent('บันทึกในประวัติ');
    await userEvent.click(within(dlg).getByRole('button', { name: 'ลบไฟล์' }));
    await waitFor(() => expect(screen.queryByRole('link', { name: 'slip.png' })).toBeNull());
    expect(loadState().audit.some((a) => a.command === 'attachment.remove' && a.target === ti.id)).toBe(true);
    cleanup();
    const dr = loadState().docs.find((x) => x.type === 'TI' && x.status === 'draft')!;
    await endpoints.addAttachment('TI', dr.id, { category: 'other', name: 'a.png', mime: 'image/png', dataUrl: 'data:image/png;base64,AAAA' });
    panel(dr.id, false);
    await userEvent.click(await screen.findByRole('button', { name: 'ลบไฟล์ a.png' }));
    await waitFor(() => expect(screen.queryByRole('link', { name: 'a.png' })).toBeNull());
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
  it('without edit rights the list is read-only', async () => {
    const d = loadState().docs.find((x) => x.type === 'TI' && x.status === 'draft')!;
    await endpoints.addAttachment('TI', d.id, { category: 'other', name: 'a.png', mime: 'image/png', dataUrl: 'data:image/png;base64,AAAA' });
    panel(d.id, false, { canEdit: false });
    await screen.findByRole('link', { name: 'a.png' });
    expect(screen.queryByLabelText('เลือกไฟล์')).toBeNull();
    expect(screen.queryByRole('button', { name: /ลบไฟล์/ })).toBeNull();
  });
  it('an unsaved editor creates its draft first (ensureDocId); with no way to make one it says to fill in the document', async () => {
    const ensure = vi.fn(async () => undefined);
    panel('', false, { docId: undefined, ensureDocId: ensure });
    await userEvent.upload(screen.getByLabelText('เลือกไฟล์'), file('po.pdf', 'application/pdf'));
    expect(ensure).toHaveBeenCalled();
    expect(await screen.findByRole('status')).toHaveTextContent('กรอกข้อมูลเอกสารก่อน');
  });
});

describe('print tracking in the document view', () => {
  it('a document not printed yet links straight to the print page', async () => {
    const ti = issuedTi();
    wrap(<DocView descriptor={taxInvoice} id={ti.id} />);
    expect(await screen.findByRole('link', { name: 'พิมพ์' })).toHaveAttribute('href', `/print/TI/${ti.id}`);
  });
  it('after the original was printed the print action asks, and confirming opens the print page on ?copy=1', async () => {
    const ti = issuedTi();
    await endpoints.markPrinted('TI', ti.id, false);
    wrap(<DocView descriptor={taxInvoice} id={ti.id} />);
    expect(screen.queryByRole('link', { name: 'พิมพ์' })).toBeNull();
    await userEvent.click(await screen.findByRole('button', { name: 'พิมพ์' }));
    const dlg = await screen.findByRole('alertdialog');
    expect(dlg).toHaveTextContent("พิมพ์ซ้ำจะพิมพ์เป็น 'สำเนา'");
    await userEvent.click(within(dlg).getByRole('button', { name: 'พิมพ์สำเนา' }));
    expect(useRouter().push).toHaveBeenCalledWith(`/print/TI/${ti.id}?copy=1`);
  });
  it('cancelling the reprint dialog prints nothing', async () => {
    const ti = issuedTi();
    await endpoints.markPrinted('TI', ti.id, false);
    wrap(<DocView descriptor={taxInvoice} id={ti.id} />);
    vi.mocked(useRouter().push).mockClear();
    await userEvent.click(await screen.findByRole('button', { name: 'พิมพ์' }));
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'ย้อนกลับ' }));
    expect(useRouter().push).not.toHaveBeenCalled();
    expect(loadState().prints).toHaveLength(1);
  });
  it('the print page button logs the print (with the copy flag) before printing', async () => {
    const ti = issuedTi();
    const print = vi.fn();
    vi.stubGlobal('print', print);
    wrap(<PaperView type="TI" id={ti.id} toolbar />);
    const btn = await screen.findByRole('button', { name: 'พิมพ์' });
    await waitFor(() => expect(btn).toBeEnabled());
    await userEvent.click(btn);
    await waitFor(() => expect(print).toHaveBeenCalled());
    expect(loadState().prints.map((p) => p.copy)).toEqual([false]);
    cleanup();
    wrap(<PaperView type="TI" id={ti.id} copy toolbar />);
    const b2 = await screen.findByRole('button', { name: 'พิมพ์' });
    await waitFor(() => expect(b2).toBeEnabled());
    await userEvent.click(b2);
    await waitFor(() => expect(loadState().prints.map((p) => p.copy)).toEqual([false, true]));
    vi.unstubAllGlobals();
  });
  it('a failed log does not block the print and says so', async () => {
    const ti = issuedTi();
    const print = vi.fn();
    vi.stubGlobal('print', print);
    const { http, HttpResponse } = await import('msw');
    testServer.use(http.post('*/bff/v1/docs/TI/:id/printed', () => HttpResponse.json({ code: 'x', title: 'x', status: 500 }, { status: 500 })));
    wrap(<PaperView type="TI" id={ti.id} toolbar />);
    const btn = await screen.findByRole('button', { name: 'พิมพ์' });
    await waitFor(() => expect(btn).toBeEnabled());
    await userEvent.click(btn);
    await waitFor(() => expect(print).toHaveBeenCalled());
    expect(await screen.findByText('บันทึกการพิมพ์ไม่สำเร็จ')).toBeVisible();
    vi.unstubAllGlobals();
  });
});

describe('default notes on a blank new document', () => {
  const editor = (props: Partial<React.ComponentProps<typeof DocEditor>> = {}) =>
    wrap(<DocEditor descriptor={quotation} mode="create" onIssued={vi.fn()} {...props} />);
  it('a blank quotation starts with the type\'s note, and opening the screen alone saves no draft', async () => {
    const calls: string[] = [];
    testServer.events.on('request:start', ({ request }) => calls.push(`${request.method} ${new URL(request.url).pathname}`));
    editor();
    const notes = await screen.findByRole('textbox', { name: 'หมายเหตุ' });
    await waitFor(() => expect(notes).toHaveValue('ใบเสนอราคานี้ยืนราคาตามที่ระบุ ราคายังไม่รวมค่าขนส่งนอกพื้นที่'));
    expect(screen.queryByText('มีการเปลี่ยนแปลงที่ยังไม่บันทึก')).toBeNull(); // the system's note is the baseline, not an unsaved edit
    await new Promise((r) => setTimeout(r, 2600)); // past the 2 s autosave idle window
    expect(calls.filter((c) => /^(POST \/bff\/v1\/docs\/QT|PUT \/bff\/v1\/docs\/QT\/.+)$/.test(c))).toEqual([]); // compute calls are fine, no draft is saved
    expect(loadState().docs.filter((d) => d.type === 'QT' && d.status === 'draft' && d.createdBy.name !== 'ผู้ช่วยบัญชี (AI)' && d.header.notes === notes.getAttribute('value'))).toEqual([]);
    testServer.events.removeAllListeners();
  }, 15000);
  it('a note the user typed first is not overwritten', async () => {
    const { http, HttpResponse, delay } = await import('msw');
    testServer.use(http.get('*/bff/v1/settings/default-notes', async () => { await delay(600); return HttpResponse.json({ QT: 'ค่าเริ่มต้น' }); })); // the defaults land after the user started typing
    editor();
    const notes = await screen.findByRole('textbox', { name: 'หมายเหตุ' });
    await userEvent.type(notes, 'ของฉัน');
    await new Promise((r) => setTimeout(r, 900));
    expect(notes).toHaveValue('ของฉัน');
  });
  it('a copy keeps the source note (no default prefill when there is initial content)', async () => {
    const src = await endpoints.getDoc('QT', (await endpoints.listDocs('QT', { status: 'issued', limit: 1 })).items[0].id);
    const copy = { ...src, id: '', number: undefined, status: 'draft' as const, version: 0, revision: 0, locks: [], issuedAt: undefined, header: { ...src.header, notes: 'หมายเหตุเดิมของต้นฉบับ' } };
    editor({ initial: copy });
    const notes = await screen.findByRole('textbox', { name: 'หมายเหตุ' });
    await new Promise((r) => setTimeout(r, 300));
    expect(notes).toHaveValue('หมายเหตุเดิมของต้นฉบับ');
  });
  it('a type without a default note starts empty', async () => {
    wrap(<DocEditor descriptor={taxInvoice} mode="create" onIssued={vi.fn()} />);
    const notes = await screen.findByRole('textbox', { name: 'หมายเหตุ' });
    await new Promise((r) => setTimeout(r, 300));
    expect(notes).toHaveValue('');
  });
});
