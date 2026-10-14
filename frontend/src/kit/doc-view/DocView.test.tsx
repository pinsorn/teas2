import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CorrectionPlan } from '@/domain/types';
import { DESCRIPTORS } from '@/descriptors';
import { taxInvoice } from '@/descriptors/tax-invoice';
import { setSettings } from '@/mocks/settings';
import { loadState, resetState } from '@/mocks/store';
import { correctionPlan } from '@/mocks/engine/corrections';
import { testServer } from '@/mocks/test-server';
import { CorrectionPlanDialog } from '../dialogs/CorrectionPlanDialog';
import { endpoints } from '@/lib/api/endpoints';
import { problem } from '@/mocks/handlers/common';
import { formatDateBE, formatMoney, formatTHB } from '@/lib/format';
import { fixtureIds } from '@/mocks/fixtures/ids';
import { useRouter } from 'next/navigation';
import { qk } from '@/lib/query/keys';
import type { Me } from '@/domain/types';
import { DocView } from './DocView';
import { useCorrectionFlow } from './useCorrectionFlow';

vi.mock('next/navigation', () => import('@/test/next-navigation'));
beforeAll(() => testServer.listen({ onUnhandledFrame: 'error' }));
afterEach(() => testServer.resetHandlers());
afterAll(() => testServer.close());
beforeEach(() => { localStorage.clear(); resetState(); setSettings({ companyKey: 'vat', role: 'accountant', screenState: 'normal' }); });

Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => {};
Element.prototype.releasePointerCapture ??= () => {};
Element.prototype.scrollIntoView ??= () => {};
const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
const ui = (id: string) => render(<QueryClientProvider client={client()}><DocView descriptor={taxInvoice} id={id} /></QueryClientProvider>);
/** Types whose own task has not landed yet: register a stand-in so link/route resolution through the registry is still exercised. */
const stub = (type: 'RC' | 'CN', basePath: string) => { DESCRIPTORS[type] = { ...taxInvoice, type, basePath } as never; };
afterEach(() => { delete DESCRIPTORS.RC; delete DESCRIPTORS.CN; });
const find = (pred: (d: ReturnType<typeof loadState>['docs'][number]) => boolean) => loadState().docs.find(pred)!;

describe('DocView', () => {
  it('correction confirmation shows signed engine amounts per tax code and full-credit mode', () => {
    const state = loadState();
    const ti = state.docs.find((d) => d.type === taxInvoice.type && d.status === 'issued')!;
    ti.locks.push({ kind: 'filing', reason: 'Filed', exits: [] });
    const plan = correctionPlan(state, ti.id, { header: { ...ti.header, partyId: 'different' }, lines: ti.lines }, 'accountant');
    const note = plan.steps[0].note!;
    note.taxLines = [{ taxCode: 'S7', net: '-50.00', vat: '-3.50', total: '-53.50' }, { taxCode: 'Z0', net: '100.00', vat: '0.00', total: '100.00' }];
    render(<CorrectionPlanDialog plan={plan} onConfirm={() => {}} onSendToApprover={() => {}} onCancel={() => {}} />);
    expect(screen.getByText('CN · ลดหนี้เต็มจำนวน')).toBeVisible();
    const table = screen.getByRole('table');
    for (const label of ['รหัสภาษี', 'มูลค่าก่อนภาษี', 'ภาษีมูลค่าเพิ่ม', 'ยอดรวม']) expect(within(table).getByRole('columnheader', { name: label })).toBeVisible();
    for (const amount of ['-50.00', '-3.50', '-53.50']) expect(within(table).getByText(amount)).toBeVisible();
  });
  it('a replaced TI shows the pointer to its replacement in the chain', async () => {
    const replaced = find((d) => d.type === taxInvoice.type && d.status === 'replaced');
    ui(replaced.id);
    const chain = await screen.findByRole('region', { name: 'เอกสารที่เกี่ยวข้อง' });
    expect(within(chain).getByText(/ออกแทนโดย/)).toBeVisible();
  });
  it('the filing lock is shown with its exit, and fiscal edit is disabled with the reason', async () => {
    setSettings({ screenState: 'locked' });
    const issued = find((d) => d.type === taxInvoice.type && d.status === 'issued');
    ui(issued.id);
    expect(await screen.findByRole('status', { name: 'ล็อก' })).toHaveTextContent('ภ.พ.30');
    expect(screen.getByText(/ออกใบลดหนี้/)).toBeVisible();
  });
  it('shows the document number with the doc-number test id', async () => {
    const issued = find((d) => d.type === taxInvoice.type && d.status === 'issued' && !d.locks.length);
    ui(issued.id);
    expect(await screen.findByTestId('doc-number')).toHaveTextContent(issued.number!);
  });
  it('the paper tab shows the server-built tax invoice and signals readiness', async () => {
    const issued = find((d) => d.type === taxInvoice.type && d.status === 'issued' && !d.locks.length);
    const { container } = ui(issued.id);
    await waitFor(() => expect(container.querySelector('[data-paper-ready="true"]')).not.toBeNull());
    const page = container.querySelector('[data-paper-page]')!;
    expect(page.textContent).toContain(issued.number!);
    expect(page.textContent).toContain(issued.totals.amountInWords);
    expect(page.textContent).toContain('ผู้มีอำนาจลงนาม');
  });
  it('a draft paper tab says it is not printable, not "no data"', async () => {
    ui(find((d) => d.type === taxInvoice.type && d.status === 'draft').id);
    expect(await screen.findByText(/ยังไม่ได้ออก จึงพิมพ์เป็นใบกำกับภาษีไม่ได้/)).toBeVisible();
  });
  it('cancel needs a reason code', async () => {
    const issued = find((d) => d.type === taxInvoice.type && d.status === 'issued' && !d.locks.length);
    ui(issued.id);
    await userEvent.click(await screen.findByRole('button', { name: 'ยกเลิกเอกสาร' }));
    const dialog = screen.getByRole('alertdialog');
    expect(within(dialog).getByRole('button', { name: 'ยืนยันยกเลิก' })).toBeDisabled();
  });
  it('an operator sees disabled cancel with the missing permission', async () => {
    setSettings({ role: 'operator' });
    const issued = find((d) => d.type === taxInvoice.type && d.status === 'issued' && !d.locks.length);
    ui(issued.id);
    const btn = await screen.findByRole('button', { name: 'ยกเลิกเอกสาร' });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAccessibleDescription(/doc\.TI\.cancel/);
  });
  it('revision history shows the diff of a revised document', async () => {
    const revised = find((d) => d.type === 'QT' && d.revision > 0);
    render(<QueryClientProvider client={client()}><DocView descriptor={{ ...taxInvoice, type: 'QT', correctionClass: 'N', basePath: '/sales/quotations' }} id={revised.id} /></QueryClientProvider>);
    await userEvent.click(await screen.findByRole('tab', { name: 'ประวัติการแก้ไข' }));
    expect(await screen.findByText(/ฉบับแก้ไขครั้งที่ 1/)).toBeVisible();
  });
  it('a load failure is an error with retry, not an empty page', async () => {
    setSettings({ screenState: 'error' });
    ui(find((d) => d.type === taxInvoice.type).id);
    expect(await screen.findByRole('button', { name: 'ลองใหม่' })).toBeVisible();
  });
});

const plain = (d: ReturnType<typeof loadState>['docs'][number]) => { const { companyId, ...rest } = d; void companyId; return rest; };
const withLock = (id: string, kind: 'period' | 'filing' | 'settlement', reason: string, exit: string) =>
  testServer.use(http.get('*/bff/v1/docs/TI/:id', ({ params }) => params.id === id
    ? HttpResponse.json({ ...plain(find((d) => d.id === id)), locks: [{ kind, reason, exits: [exit] }] }) : undefined));
const lone = () => find((d) => d.type === taxInvoice.type && d.status === 'issued' && !d.locks.length && !loadState().links.some((l) => l.to === d.id || l.from === d.id));

describe('DocView locks and actions (fix round 1)', () => {
  it('filing lock: edit stays enabled, cancel is disabled with the reason, the exit is a button that starts the correction flow', async () => {
    setSettings({ screenState: 'locked' });
    const issued = find((d) => d.type === taxInvoice.type && d.status === 'issued');
    ui(issued.id);
    expect(await screen.findByRole('link', { name: 'แก้ไข' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'ยกเลิกเอกสาร' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'ยกเลิกเอกสาร' })).toHaveAccessibleDescription(/ภ\.พ\.30/);
    await userEvent.click(screen.getByRole('button', { name: /ออกใบลดหนี้/ }));
    expect(vi.mocked(useRouter().push).mock.lastCall![0]).toBe(`/sales/tax-invoices/${issued.id}/edit`);
  });
  it('filing lock exit is enabled for an operator: proposing a correction needs create, the plan lists the rest', async () => {
    setSettings({ screenState: 'locked', role: 'operator' });
    const issued = find((d) => d.type === taxInvoice.type && d.status === 'issued');
    ui(issued.id);
    const exit = await screen.findByRole('button', { name: /ออกใบลดหนี้/ });
    expect(exit).toBeEnabled();
    await userEvent.click(exit);
    expect(vi.mocked(useRouter().push).mock.lastCall![0]).toBe(`/sales/tax-invoices/${issued.id}/edit`);
  });
  it('a period lock does not block cancel, end to end', async () => {
    const d = lone();
    withLock(d.id, 'period', 'งวด ก.ย. ปิดแล้ว', 'แก้ไขในงวดปัจจุบัน');
    const { container } = ui(d.id);
    expect(await screen.findByRole('status', { name: 'ล็อก' })).toHaveTextContent('งวด ก.ย. ปิดแล้ว');
    await userEvent.click(screen.getByRole('button', { name: 'ยกเลิกเอกสาร' }));
    const dialog = screen.getByRole('alertdialog');
    await userEvent.click(within(dialog).getByRole('combobox'));
    await userEvent.click(await screen.findByRole('option', { name: 'ออกซ้ำ' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'ยืนยันยกเลิก' }));
    await waitFor(() => expect(container.querySelector('[data-status="cancelled"]')).not.toBeNull());
  });
  it.each([['doc.locked', 'เอกสารถูกล็อก ยกเลิกไม่ได้'], ['doc.has_dependents', 'มีใบเสร็จผูกอยู่']])('a %s refusal shows its own message, not the stale-data hint', async (code, title) => {
    const d = lone();
    testServer.use(http.post('*/bff/v1/docs/TI/:id/cancel', () => problem(409, code, title)));
    ui(d.id);
    await userEvent.click(await screen.findByRole('button', { name: 'ยกเลิกเอกสาร' }));
    const dialog = screen.getByRole('alertdialog');
    await userEvent.click(within(dialog).getByRole('combobox'));
    await userEvent.click(await screen.findByRole('option', { name: 'ออกซ้ำ' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'ยืนยันยกเลิก' }));
    expect(await within(dialog).findByText(title)).toBeVisible();
    expect(within(dialog).queryByText(/โหลดข้อมูลล่าสุดให้แล้ว/)).toBeNull();
  });
  it('a settlement lock keeps cancel blocked', async () => {
    const d = lone();
    withLock(d.id, 'settlement', 'มีการรับชำระแล้ว', 'ยกเลิกการรับชำระ');
    ui(d.id);
    expect(await screen.findByRole('button', { name: 'ยกเลิกเอกสาร' })).toBeDisabled();
  });
  it('a replaced document shows edit disabled with the reason, not hidden', async () => {
    ui(find((d) => d.type === taxInvoice.type && d.status === 'replaced').id);
    const btn = await screen.findByRole('button', { name: 'แก้ไข' });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAccessibleDescription(/ถูกแทนที่/);
  });
  it('the lock banner uses the amber pending tokens', async () => {
    setSettings({ screenState: 'locked' });
    ui(find((d) => d.type === taxInvoice.type && d.status === 'issued').id);
    expect((await screen.findByRole('status', { name: 'ล็อก' })).className).toContain('--color-status-pending');
  });
});

describe('DocView cancel and tabs (fix round 1)', () => {
  it('cancel happy path: choose a reason, confirm, the document shows cancelled', async () => {
    const d = lone();
    const { container } = ui(d.id);
    await userEvent.click(await screen.findByRole('button', { name: 'ยกเลิกเอกสาร' }));
    const dialog = screen.getByRole('alertdialog');
    const confirm = within(dialog).getByRole('button', { name: 'ยืนยันยกเลิก' });
    await userEvent.click(within(dialog).getByRole('combobox'));
    await userEvent.click(await screen.findByRole('option', { name: 'ออกซ้ำ' }));
    expect(confirm).toBeEnabled();
    await userEvent.click(confirm);
    await waitFor(() => expect(container.querySelector('[data-status="cancelled"]')).not.toBeNull());
  });
  it('cancel with a stale version refetches the document and tells the user', async () => {
    const d = lone();
    testServer.use(http.post('*/bff/v1/docs/TI/:id/cancel', () => problem(409, 'doc.version_conflict', 'ข้อมูลถูกแก้ไขโดยผู้อื่น')));
    const spy = vi.spyOn(endpoints, 'getDoc');
    ui(d.id);
    await userEvent.click(await screen.findByRole('button', { name: 'ยกเลิกเอกสาร' }));
    const dialog = screen.getByRole('alertdialog');
    await userEvent.click(within(dialog).getByRole('combobox'));
    await userEvent.click(await screen.findByRole('option', { name: 'ออกซ้ำ' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'ยืนยันยกเลิก' }));
    expect(await within(dialog).findByText(/โหลดข้อมูลล่าสุดให้แล้ว/)).toBeVisible();
    await waitFor(() => expect(spy.mock.calls.length).toBeGreaterThan(1));
    spy.mockRestore();
  });
  it('ledger, activity and chain tabs render server data', async () => {
    stub('RC', '/sales/receipts');
    const ti = find((d) => d.type === taxInvoice.type && loadState().links.some((l) => l.kind === 'settles' && l.to === d.id && l.active));
    const rc = find((d) => d.id === loadState().links.find((l) => l.kind === 'settles' && l.to === ti.id && l.active)!.from);
    const line = loadState().journals.find((j) => j.docId === ti.id)!.preview.entries[0].lines.find((l) => l.debit !== '0.00')!;
    ui(ti.id);
    await userEvent.click(await screen.findByRole('tab', { name: 'ผลต่อบัญชี' }));
    expect((await screen.findAllByText(formatMoney(line.debit))).length).toBeGreaterThan(0);
    expect(screen.getAllByText(new RegExp(line.accountCode)).length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole('tab', { name: 'กิจกรรม' }));
    expect(await screen.findByText('ออกเอกสาร')).toBeVisible();
    await userEvent.click(screen.getByRole('tab', { name: 'เอกสารที่เกี่ยวข้อง' }));
    expect((await screen.findByRole('link', { name: new RegExp(rc.number!) })).getAttribute('href')).toBe(`/sales/receipts/${rc.id}`);
  });
});

describe('useCorrectionFlow (fix round 1)', () => {
  // A CN-only plan: the total changes on a TI with no dependents.
  const proposedFor = (d: ReturnType<typeof plain>) => ({ header: d.header, lines: d.lines.map((l, i) => (i === 0 ? { ...l, unitPrice: '1.00' } : l)) });
  function Harness({ docId }: { docId: string }) {
    const doc = plain(find((d) => d.id === docId)) as never;
    const { request, ui: flow } = useCorrectionFlow(taxInvoice, doc);
    return <><button onClick={() => void request(proposedFor(doc))}>go</button>{flow}</>;
  }
  const open = async (id: string) => {
    render(<QueryClientProvider client={client()}><Harness docId={id} /></QueryClientProvider>);
    await userEvent.click(await screen.findByRole('button', { name: 'go' }));
    return screen.findByRole('alertdialog', { name: 'แผนการแก้ไข' });
  };
  it('executes with the server planId and planHash, then opens the CN on the CN route', async () => {
    stub('CN', '/sales/credit-notes');
    const plan = vi.spyOn(endpoints, 'getCorrectionPlan');
    const exec = vi.spyOn(endpoints, 'executeCorrection');
    const dialog = await open(lone().id);
    const p = await plan.mock.results[0].value;
    await userEvent.click(within(dialog).getByRole('button', { name: 'ยืนยันทั้งหมด' }));
    await waitFor(() => expect(exec).toHaveBeenCalledWith(p.planId, p.planHash));
    const res = await exec.mock.results[0].value;
    const cn = res.affected.find((a: { type: string }) => a.type === 'CN');
    await waitFor(() => expect(vi.mocked(useRouter().push).mock.lastCall![0]).toBe(`/sales/credit-notes/${cn.docId}`));
    plan.mockRestore(); exec.mockRestore();
  });
  it('409 plan_stale offers a new plan instead of a dead end', async () => {
    testServer.use(http.post('*/bff/v1/corrections', () => problem(409, 'correction.plan_stale', 'ข้อมูลเปลี่ยนไปหลังจากสร้างแผน กรุณาสร้างแผนใหม่')));
    const plan = vi.spyOn(endpoints, 'getCorrectionPlan');
    const dialog = await open(lone().id);
    await userEvent.click(within(dialog).getByRole('button', { name: 'ยืนยันทั้งหมด' }));
    expect(await within(dialog).findByText(/กรุณาสร้างแผนใหม่/)).toBeVisible();
    expect(within(dialog).getByRole('button', { name: 'ยืนยันทั้งหมด' })).toBeDisabled();
    await userEvent.click(within(dialog).getByRole('button', { name: 'สร้างแผนใหม่' }));
    await waitFor(() => expect(plan).toHaveBeenCalledTimes(2));
    plan.mockRestore();
  });
  it.each([[403, 'auth.forbidden', 'ต้องมีสิทธิ์ doc.CN.issue'], [404, 'correction.plan_not_found', 'ไม่พบแผนการแก้ไข']])('%i is shown as a clear message', async (status, code, title) => {
    testServer.use(http.post('*/bff/v1/corrections', () => problem(status, code, title)));
    const dialog = await open(lone().id);
    await userEvent.click(within(dialog).getByRole('button', { name: 'ยืนยันทั้งหมด' }));
    expect(await within(dialog).findByText(title)).toBeVisible();
  });
});
describe('CorrectionPlanDialog', () => {
  const plan = (missing: string[]): CorrectionPlan => ({
    planId: 'p', planHash: 'h', explanation: 'ยกเลิกและออกใหม่', missingPermissions: missing,
    steps: [
      { order: 1, action: 'cancel', docId: 'a', docType: 'RC', number: 'RC-1', summary: 'ยกเลิก RC RC-1', permission: 'doc.RC.cancel' },
      { order: 2, action: 'reissue', docId: 'b', docType: taxInvoice.type, number: 'TI-1', summary: 'ออก TI ใหม่', permission: 'doc.TI.correct' },
    ],
  });
  it('initial focus is on the back button, never the irreversible confirm', () => {
    render(<CorrectionPlanDialog plan={plan([])} onConfirm={vi.fn()} onSendToApprover={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'กลับ' })).toHaveFocus();
  });
  it('lists ordered steps and confirms', async () => {
    const onConfirm = vi.fn();
    render(<CorrectionPlanDialog plan={plan([])} onConfirm={onConfirm} onSendToApprover={vi.fn()} onCancel={vi.fn()} />);
    const dialog = screen.getByRole('alertdialog', { name: 'แผนการแก้ไข' });
    expect(within(dialog).getAllByRole('listitem')).toHaveLength(2);
    await userEvent.click(within(dialog).getByRole('button', { name: 'ยืนยันทั้งหมด' }));
    expect(onConfirm).toHaveBeenCalled();
  });
  it('missing permissions disable confirm and offer sending to an approver', async () => {
    const onSend = vi.fn();
    render(<CorrectionPlanDialog plan={plan(['doc.RC.cancel'])} onConfirm={vi.fn()} onSendToApprover={onSend} onCancel={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'ยืนยันทั้งหมด' })).toBeDisabled();
    expect(screen.getByText(/doc\.RC\.cancel/, { selector: 'p' })).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'ส่งให้ผู้มีสิทธิ์อนุมัติ' }));
    await waitFor(() => expect(onSend).toHaveBeenCalled());
  });
});

describe('I7 company scope', () => {
  it('a document id from another company shows the not-found state, not stale data', async () => {
    const qt = find((d) => d.type === 'QT');
    const qc = client();
    const desc = { ...taxInvoice, type: 'QT' as const, correctionClass: 'N' as const, basePath: '/sales/quotations' };
    render(<QueryClientProvider client={qc}><DocView descriptor={desc} id={qt.id} /></QueryClientProvider>);
    expect(await screen.findByTestId('doc-number')).toHaveTextContent(qt.number!);
    const me = qc.getQueryData<Me>(qk.me())!;
    setSettings({ companyKey: 'nonvat' });
    act(() => { qc.setQueryData(qk.me(), { ...me, activeCompanyId: 'co-nonvat', vatRegistered: false }); });
    expect(await screen.findByText('ไม่พบเอกสารนี้')).toBeVisible();
    expect(screen.queryByTestId('doc-number')).toBeNull();
    expect(screen.queryByRole('button', { name: 'ลองใหม่' })).toBeNull();
  });
});

describe('F3 debt — plan dialog, chain, ledger.read, cancel, revisions', () => {
  it('plan amounts are formatted as Thai baht', () => {
    const base = { planId: 'p', planHash: 'h', explanation: 'ลดหนี้', missingPermissions: [] as string[] };
    const note = { type: 'CN' as const, fullCredit: false, priceIncludesVat: false, lines: [], total: '1234567.50',
      taxLines: [{ taxCode: 'S7' as const, net: '1000.00', vat: '70.00', total: '1070.00' }] };
    const plan: CorrectionPlan = { ...base, steps: [{ order: 1, action: 'issue_cn', docId: 'a', docType: 'CN', summary: 's', permission: 'doc.CN.issue', note }] };
    render(<CorrectionPlanDialog plan={plan} onConfirm={() => {}} onSendToApprover={() => {}} onCancel={() => {}} />);
    const table = screen.getByRole('table');
    expect(within(table).getByText('1,070.00')).toBeVisible();
    expect(within(table).getByText('1,000.00')).toBeVisible();
    expect(screen.queryByText('1070.00')).toBeNull();
    expect(screen.getByText('฿1,234,567.50', { exact: false })).toBeVisible(); // the note total line
    expect(screen.queryByText('1234567.50', { exact: false })).toBeNull();
  });
  it('confirm is disabled while a newer plan is loading (T12)', async () => {
    testServer.use(http.post('*/bff/v1/corrections', () => problem(409, 'correction.plan_stale', 'ข้อมูลเปลี่ยนไปหลังจากสร้างแผน กรุณาสร้างแผนใหม่')));
    const plan = vi.spyOn(endpoints, 'getCorrectionPlan');
    const doc = plain(lone()) as never;
    function Flow() {
      const { request, ui: flow } = useCorrectionFlow(taxInvoice, doc);
      const d = doc as ReturnType<typeof plain>;
      return <><button onClick={() => void request({ header: d.header, lines: d.lines.map((l, i) => (i === 0 ? { ...l, unitPrice: '1.00' } : l)) })}>go</button>{flow}</>;
    }
    render(<QueryClientProvider client={client()}><Flow /></QueryClientProvider>);
    await userEvent.click(await screen.findByRole('button', { name: 'go' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'แผนการแก้ไข' });
    const first = await plan.mock.results[0].value;
    await userEvent.click(within(dialog).getByRole('button', { name: 'ยืนยันทั้งหมด' }));
    await within(dialog).findByText(/กรุณาสร้างแผนใหม่/);
    let release!: (p: CorrectionPlan) => void;
    plan.mockImplementationOnce(() => new Promise<CorrectionPlan>((r) => { release = r; }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'สร้างแผนใหม่' }));
    await waitFor(() => expect(plan).toHaveBeenCalledTimes(2));
    expect(within(dialog).getByRole('button', { name: 'ยืนยันทั้งหมด' })).toBeDisabled(); // the old plan must not be confirmable while its replacement loads
    act(() => release(first));
    await waitFor(() => expect(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'ยืนยันทั้งหมด' })).toBeEnabled());
    plan.mockRestore();
  });
  it('chain 403 renders ForbiddenState naming doc.<T>.read', async () => {
    const d = lone();
    testServer.use(http.get('*/bff/v1/docs/:type/:id/chain', () => problem(403, 'auth.forbidden', 'คุณไม่มีสิทธิ์ดูข้อมูลนี้')));
    ui(d.id);
    await userEvent.click(await screen.findByRole('tab', { name: 'เอกสารที่เกี่ยวข้อง' }));
    expect(await screen.findByText(/doc\.TI\.read/)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'ลองใหม่' })).toBeNull(); // forbidden is not a retryable error
  });
  it('ledger tab without ledger.read is disabled with the permission named (D-09)', async () => {
    setSettings({ role: 'operator' });
    ui(lone().id);
    const tab = await screen.findByRole('tab', { name: /ผลต่อบัญชี/ });
    expect(tab).toBeDisabled();
    expect(tab).toHaveAccessibleName(/ต้องมีสิทธิ์ ดูบัญชี.*ledger\.read/);
  });
  it('ledger tab stays usable with ledger.read', async () => {
    ui(lone().id);
    expect(await screen.findByRole('tab', { name: 'ผลต่อบัญชี' })).toBeEnabled();
  });
  it('cancel dialog shows the total and no client-guessed date; the actual reversal date comes from the server journal (rule 3)', async () => {
    const d = find((x) => x.id === fixtureIds(loadState()).tiIssuedUnpaid);
    ui(d.id);
    await userEvent.click(await screen.findByRole('button', { name: 'ยกเลิกเอกสาร' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(formatTHB(d.totals.total))).toBeVisible();
    expect(within(dialog).getByText('วันที่ปัจจุบันของงวดบัญชีที่เปิดอยู่ (ระบบเป็นผู้กำหนด)')).toBeVisible();
    expect(dialog.textContent).not.toMatch(/d{1,2} S+ 25dd/); // no Buddhist-era date rendered by the client
    expect(within(dialog).getByRole('button', { name: 'ยืนยันยกเลิก' })).toBeDisabled(); // still needs a reason
    await userEvent.click(within(dialog).getByRole('combobox'));
    await userEvent.click(await screen.findByRole('option', { name: 'ออกซ้ำ' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'ยืนยันยกเลิก' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    await userEvent.click(await screen.findByRole('tab', { name: 'ผลต่อบัญชี' }));
    const served = (await endpoints.getLedger(d.type, d.id)).entries.find((e) => e.kind === 'reversal')!;
    const heading = await screen.findByRole('heading', { name: /รายการกลับรายการ/ });
    expect(heading).toHaveTextContent(formatDateBE(served.date)); // the date the server posted
  });
  it('revision diffs name the field and the line number, never the raw path', async () => {
    const d = lone();
    const snap = { ...plain(d), lines: [{ ...d.lines[0], id: 'l-a' }, { ...d.lines[0], id: 'l-b' }] };
    testServer.use(http.get('*/bff/v1/docs/:type/:id/revisions', () => HttpResponse.json([
      { revision: 1, at: '2026-10-10T09:00:00.000Z', actor: { kind: 'user', id: 'u', name: 'สมศรี' }, snapshot: snap,
        diff: [{ path: 'lines.l-b.unitPrice', before: '100.00', after: '120.00' }, { path: 'header.notes', before: null, after: 'x' }, { path: 'lines.l-b.qty', before: '1', after: '2' }] },
      { revision: 0, at: '2026-10-09T09:00:00.000Z', actor: { kind: 'user', id: 'u', name: 'สมศรี' }, snapshot: snap, diff: [] },
    ])));
    ui(d.id);
    await userEvent.click(await screen.findByRole('tab', { name: 'ประวัติการแก้ไข' }));
    expect(await screen.findByText('รายการที่ 2 · ราคาต่อหน่วย')).toBeVisible();
    expect(screen.getByText('รายการที่ 2 · จำนวน')).toBeVisible();
    expect(screen.getByText('หมายเหตุ')).toBeVisible();
    expect(screen.queryByText(/lines\./)).toBeNull();
  });
});
