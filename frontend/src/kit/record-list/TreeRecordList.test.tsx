import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecordRow } from '@/domain/records';
import { __setSearch } from '@/test/next-navigation';
import { setSettings } from '@/mocks/settings';
import { resetState } from '@/mocks/store';
import { testServer } from '@/mocks/test-server';
import { RECORDS } from '@/records';
import { TreeRecordList, buildTree } from './TreeRecordList';

vi.mock('next/navigation', () => import('@/test/next-navigation'));
beforeAll(() => testServer.listen({ onUnhandledFrame: 'error' }));
afterEach(() => { cleanup(); testServer.resetHandlers(); });
afterAll(() => testServer.close());
beforeEach(() => { __setSearch(''); localStorage.clear(); resetState(); setSettings({ companyKey: 'vat', role: 'accountant', screenState: 'normal' }); });

const r = (code: string, parent: string | undefined, over: Partial<RecordRow> = {}): RecordRow =>
  ({ id: code, version: 1, active: true, code, name: `บัญชี ${code}`, ...(parent ? { parent } : {}), postable: !!parent, ...over });
const ROWS = [r('5110', '5000'), r('1100', '1000'), r('5000', undefined), r('1000', undefined), r('1110', '1100', { name: 'เงินสด' }), r('5120', '5000', { active: false }), r('1130', '1100')];
const shape = (q = '', active: 'true' | 'false' | 'all' = 'all') => buildTree(ROWS, { q, active }).map((n) => `${n.depth}:${n.row.code}`);

describe('buildTree', () => {
  it('orders depth-first by code, parents before children, indented by depth', () => {
    expect(shape()).toEqual(['0:1000', '1:1100', '2:1110', '2:1130', '0:5000', '1:5110', '1:5120']);
  });
  it('search keeps the ancestors of every match (and matches on name too)', () => {
    expect(shape('1130')).toEqual(['0:1000', '1:1100', '2:1130']);
    expect(shape('เงินสด')).toEqual(['0:1000', '1:1100', '2:1110']);
    expect(shape('ไม่มีแน่นอน')).toEqual([]);
  });
  it('the active filter hides inactive accounts but keeps an ancestor of a visible one', () => {
    expect(shape('', 'true')).toEqual(['0:1000', '1:1100', '2:1110', '2:1130', '0:5000', '1:5110']);
    expect(shape('', 'false')).toEqual(['0:5000', '1:5120']);
  });
  it('an account whose parent is not in the data is a root', () => {
    expect(buildTree([r('1130', '1100')], { q: '', active: 'all' }).map((n) => n.depth)).toEqual([0]);
  });
  it('marks which rows have sub-accounts (to collapse)', () => {
    expect(buildTree(ROWS, { q: '', active: 'all' }).filter((n) => n.hasChildren).map((n) => n.row.code)).toEqual(['1000', '1100', '5000']);
  });
});

const mount = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><TreeRecordList descriptor={RECORDS.account!} /></QueryClientProvider>);

describe('TreeRecordList', { timeout: 20_000 }, () => { // ~70 rows rendered per test: slow when the whole suite runs in parallel
  it('renders the chart as a tree: header rows bold, collapse hides the sub-accounts, expand brings them back', async () => {
    mount();
    expect(await screen.findByRole('heading', { level: 1, name: 'ผังบัญชี' })).toBeVisible();
    const row = (code: string) => screen.queryByRole('row', { name: new RegExp(`^${code} `) });
    expect(await screen.findByRole('row', { name: /^1130 / })).toBeVisible();
    expect(row('1100')).toHaveClass('font-semibold'); // a header account
    expect(row('1130')).not.toHaveClass('font-semibold');
    await userEvent.click(screen.getByRole('button', { name: 'ย่อ 1100' }));
    expect(row('1130')).toBeNull();
    expect(row('1100')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'ขยาย 1100' }));
    expect(row('1130')).toBeVisible();
  });

  it('search keeps the ancestors of a match visible', async () => {
    mount();
    await screen.findByRole('row', { name: /^1130 / });
    await userEvent.type(screen.getByRole('searchbox', { name: 'ค้นหา' }), '1130');
    await waitFor(() => expect(screen.queryByRole('row', { name: /^1110 / })).toBeNull());
    expect(screen.getByRole('row', { name: /^1130 / })).toBeVisible();
    expect(screen.getByRole('row', { name: /^1100 / })).toBeVisible(); // the parent
    expect(screen.getByRole('row', { name: /^1000 / })).toBeVisible(); // the grand-parent
  });

  it('deactivating an account a posting rule maps names the rule and the exit; the account stays active', async () => {
    mount();
    const row = await screen.findByRole('row', { name: /^1130 / });
    await userEvent.click(within(row).getByRole('button', { name: 'ปิดใช้งาน' }));
    await userEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'ปิดใช้งาน' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('“AR”');
    expect(alert).toHaveTextContent('แก้ที่ ตั้งค่า → การลงบัญชี');
    expect(screen.getByRole('row', { name: /^1130 / })).toBeVisible();
  });

  it('a used account opens with its code, class, sub-class and posting flag locked; renaming still saves', async () => {
    mount();
    await userEvent.click(await screen.findByRole('button', { name: '1130' }));
    const dlg = await screen.findByRole('dialog');
    expect(within(dlg).getByLabelText('รหัส')).toHaveAttribute('readonly');
    for (const label of ['หมวดบัญชี', 'ประเภทย่อย', 'ลงรายการได้ (ไม่ใช่บัญชีหมวด)']) expect(within(dlg).getByLabelText(label)).toBeDisabled();
    expect(within(dlg).getByLabelText('บัญชีหมวดที่อยู่ภายใต้')).toBeEnabled();
    expect(within(dlg).getByLabelText('หมวดบัญชี')).toHaveValue('current-asset'); // locked, but the value is still in the form
    await userEvent.clear(within(dlg).getByLabelText('ชื่อบัญชี (ไทย)'));
    await userEvent.type(within(dlg).getByLabelText('ชื่อบัญชี (ไทย)'), 'ลูกหนี้ในประเทศ');
    await userEvent.click(within(dlg).getByRole('button', { name: 'บันทึก' }));
    expect(await screen.findByText('ลูกหนี้ในประเทศ')).toBeVisible();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('adds 5190 under 5000 through the form: the new account appears under its header', async () => {
    mount();
    await screen.findByRole('row', { name: /^5000 / });
    await userEvent.click(screen.getByRole('button', { name: 'เพิ่มผังบัญชี' }));
    const dlg = await screen.findByRole('dialog');
    await userEvent.type(within(dlg).getByLabelText('รหัส'), '5190');
    await userEvent.type(within(dlg).getByLabelText('ชื่อบัญชี (ไทย)'), 'ค่าใช้จ่ายเบ็ดเตล็ด');
    await waitFor(() => expect(within(dlg).getByRole('option', { name: '5000 · ค่าใช้จ่าย' })).toBeInTheDocument());
    await userEvent.selectOptions(within(dlg).getByLabelText('บัญชีหมวดที่อยู่ภายใต้'), '5000');
    await userEvent.selectOptions(within(dlg).getByLabelText('หมวดบัญชี'), 'selling-admin-expense');
    await userEvent.selectOptions(within(dlg).getByLabelText('ประเภทย่อย'), 'expense');
    await userEvent.click(within(dlg).getByRole('button', { name: 'บันทึก' }));
    expect(await screen.findByRole('row', { name: /^5190 ค่าใช้จ่ายเบ็ดเตล็ด/ })).toBeVisible();
  });

  it('the operator (no ledger.read) gets the forbidden state, never an empty chart', async () => {
    setSettings({ companyKey: 'vat', role: 'operator', screenState: 'normal' });
    mount();
    expect(await screen.findByText(/ledger\.read/)).toBeVisible();
  });
});
