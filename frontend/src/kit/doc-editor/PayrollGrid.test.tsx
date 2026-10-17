import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { payrollRun } from '@/descriptors/payroll-run';
import type { RecordRow } from '@/domain/records';
import type { DocLine, Me, PayslipLine } from '@/domain/types';
import { qk } from '@/lib/query/keys';
import { setSettings } from '@/mocks/settings';
import { loadState, resetState } from '@/mocks/store';
import { testServer } from '@/mocks/test-server';
import { DocEditor } from './DocEditor';
import { defaultPayrollLines, newPayrollLine, PayrollGrid, payrollLinePayload } from './PayrollGrid';

vi.mock('next/navigation', () => import('@/test/next-navigation'));
beforeAll(() => testServer.listen({ onUnhandledFrame: 'error' }));
afterEach(async () => { cleanup(); await new Promise((r) => setTimeout(r, 100)); testServer.resetHandlers(); testServer.events.removeAllListeners(); });
afterAll(() => testServer.close());
beforeEach(() => { localStorage.clear(); resetState(); setSettings({ companyKey: 'vat', role: 'accountant', screenState: 'normal' }); });

const EMPLOYEES = [
  { id: 'e-1', version: 1, active: true, code: 'E01', name: 'สมศรี บัญชีดี', salary: '45000.00', startDate: '2024-01-01' },
  { id: 'e-2', version: 1, active: true, code: 'E02', name: 'วิชาญ ขยันงาน', salary: '30000.00', startDate: '2024-06-01' },
] as RecordRow[];
const line = (employeeId: string, pay: DocLine['pay'] = { salary: '45000.00' }): DocLine => ({ ...newPayrollLine(employeeId), id: `l-${employeeId}`, pay });
/** Deliberately inconsistent figures: gross 100 - PIT 5 - SSO 7 is not 999. If the grid computed anything, these would not survive. */
const SLIP: PayslipLine = { employeeId: 'e-1', name: 'สมศรี บัญชีดี', gross: '100.00', pit: '5.00', sso: '7.00', ssoEmployer: '7.00', otherDeduction: '0.00', net: '999.00', ytdIncome: '12345.67', ytdPit: '8.88' };

function Host({ initial, slips, spy }: { initial: DocLine[]; slips?: PayslipLine[]; spy?: (l: DocLine[]) => void }) {
  const [lines, setLines] = useState(initial);
  return <PayrollGrid lines={lines} employees={EMPLOYEES} slips={slips} totals={{ gross: '111.11', pit: '2.22', sso: '3.33', ssoEmployer: '4.44', net: '555.55' }} onChange={(l) => { setLines(l); spy?.(l); }} />;
}
const mount = (ui: React.ReactElement) => { const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } }); return { qc, ...render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>) }; };

describe('PayrollGrid: the server\'s figures are shown, never computed', () => {
  it('shows the slip and the totals exactly as given - even when they do not add up - and typing never changes them', async () => {
    const spy = vi.fn();
    mount(<Host initial={[line('e-1')]} slips={[SLIP]} spy={spy} />);
    expect(screen.getByTestId('slip-gross')).toHaveTextContent('100.00');
    expect(screen.getByTestId('slip-pit')).toHaveTextContent('5.00');
    expect(screen.getByTestId('slip-sso')).toHaveTextContent('7.00');
    expect(screen.getByTestId('slip-net')).toHaveTextContent('999.00');
    expect(screen.getByTestId('slip-ytd-income')).toHaveTextContent('12,345.67');
    expect(screen.getByTestId('slip-ytd-pit')).toHaveTextContent('8.88');
    for (const [k, v] of Object.entries({ gross: '111.11', pit: '2.22', sso: '3.33', ssoEmployer: '4.44', net: '555.55' })) expect(screen.getByTestId(`total-${k}`)).toHaveTextContent(v);
    await userEvent.type(screen.getByRole('textbox', { name: 'ค่าล่วงเวลา (OT) สมศรี บัญชีดี' }), '1500');
    expect(spy).toHaveBeenLastCalledWith([expect.objectContaining({ pay: expect.objectContaining({ overtime: '1500' }) })]);
    expect(screen.getByTestId('slip-gross')).toHaveTextContent('100.00'); // not 46,500.00: only a new answer from the server changes it
    expect(screen.getByTestId('slip-net')).toHaveTextContent('999.00');
    expect(screen.getByTestId('total-net')).toHaveTextContent('555.55');
  });

  it('a row with no answer yet shows nothing (a dash of dots while computing), never a guess', () => {
    mount(<PayrollGrid lines={[line('e-1')]} employees={EMPLOYEES} computing onChange={vi.fn()} />);
    expect(screen.getByTestId('slip-net')).toHaveTextContent('…');
    expect(screen.getByTestId('total-net')).toHaveTextContent('…');
  });

  it('read-only: no inputs, no remove, no add; the prorated days the server returned are named', () => {
    mount(<PayrollGrid lines={[line('e-1')]} employees={EMPLOYEES} slips={[{ ...SLIP, proratedDays: 17 }]} readOnly onChange={vi.fn()} />);
    expect(screen.getAllByRole('textbox').every((t) => t.hasAttribute('readonly'))).toBe(true);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByTestId('payroll-prorated')).toHaveTextContent('17 วัน');
  });
});

describe('PayrollGrid: rows and keyboard', () => {
  it('picking an employee takes their salary from the record; Enter walks salary, overtime ... other deduction, then the next row; Enter on the very last cell adds a row', async () => {
    const spy = vi.fn();
    mount(<Host initial={[newPayrollLine()]} spy={spy} />);
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'พนักงานรายการ 1' }), 'e-2');
    expect(spy).toHaveBeenLastCalledWith([expect.objectContaining({ employeeId: 'e-2', pay: expect.objectContaining({ salary: '30000.00' }) })]);
    const salary = screen.getByRole('textbox', { name: 'เงินเดือน วิชาญ ขยันงาน' });
    await userEvent.click(salary);
    for (const name of ['ค่าล่วงเวลา (OT)', 'เบี้ยเลี้ยง/ค่าตำแหน่ง', 'โบนัส', 'รายได้อื่น', 'รายการหักอื่น']) {
      await userEvent.keyboard('{Enter}');
      expect(screen.getByRole('textbox', { name: `${name} วิชาญ ขยันงาน` })).toHaveFocus();
    }
    await userEvent.keyboard('{Enter}'); // the last cell of the last row
    expect(screen.getAllByTestId('payroll-row')).toHaveLength(2);
    expect(screen.getByRole('combobox', { name: 'พนักงานรายการ 2' })).toHaveFocus();
  });

  it('an employee already in the run is not offered in another row; a row can be removed', async () => {
    mount(<Host initial={[line('e-1'), newPayrollLine()]} />);
    const picker = screen.getByRole('combobox', { name: 'พนักงานรายการ 2' });
    expect(within(picker).queryByRole('option', { name: /E01/ })).toBeNull();
    expect(within(picker).getByRole('option', { name: /E02/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'เอาพนักงานรายการ 1 ออก' }));
    expect(screen.getAllByTestId('payroll-row')).toHaveLength(1);
  });

  it('sends money as n.nn, the salary always and an untyped item not at all; a row with no employee is not a row', () => {
    const p = payrollLinePayload({ ...line('e-1', { salary: '45000', overtime: '1500.5' }) });
    expect(p.pay).toEqual({ salary: '45000.00', overtime: '1500.50' });
  });

  it('a new run starts with the active employees who work in the pay date\'s month (the server re-checks every row)', () => {
    const rows = loadState().parties.filter((p) => p.companyId === 'co-vat' && p.kind === 'employee').map((p) => ({ id: p.id, version: 1, active: p.active !== false, code: p.code, startDate: p.payroll!.startDate, endDate: p.payroll!.endDate, salary: p.payroll!.salary })) as RecordRow[];
    const ids = (d: string) => defaultPayrollLines(rows, d).map((l) => l.employeeId);
    expect(ids('2026-10-14')).toEqual(['emp-01', 'emp-02', 'emp-03', 'emp-04']); // emp-05 left on 20 Sep; emp-04 starts 15 Oct (in the month)
    expect(ids('2026-09-30')).toEqual(['emp-01', 'emp-02', 'emp-03', 'emp-05']); // the leaver is paid for September; the joiner is not yet in
    expect(ids('2026-08-31')).toEqual(['emp-01', 'emp-02', 'emp-03', 'emp-05']);
    expect(defaultPayrollLines(rows.map((r) => (r.id === 'emp-02' ? { ...r, active: false } : r)), '2026-10-14').map((l) => l.employeeId)).not.toContain('emp-02'); // deactivated
    expect(defaultPayrollLines(rows, '2026-10-14')[0].pay?.salary).toBe('120000.00'); // the master's salary is the starting point
  });
});

describe('the payroll editor', () => {
  const ui = () => mount(<DocEditor descriptor={payrollRun} mode="create" onIssued={vi.fn()} />);
  const calls: string[] = [];
  beforeEach(() => { calls.length = 0; testServer.events.on('request:start', ({ request }) => calls.push(`${request.method} ${new URL(request.url).pathname}`)); });

  it('opens with the month\'s employees, the server\'s slips beside them (the joiner prorated), and saves no draft merely by being opened', async () => {
    ui();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('สร้างรอบเงินเดือน');
    await waitFor(() => expect(screen.getAllByTestId('payroll-row')).toHaveLength(4), { timeout: 8000 }); // emp-01..04 on 14 Oct
    await waitFor(() => expect(screen.getAllByTestId('payroll-prorated')).toHaveLength(1), { timeout: 12000 });
    expect(screen.getByTestId('payroll-prorated')).toHaveTextContent('17 วัน');
    expect(screen.getAllByTestId('slip-sso').some((x) => x.textContent === '685.48')).toBe(true); // the joiner's SSO, from the server
    await new Promise((r) => setTimeout(r, 2500)); // longer than the autosave idle time
    expect(calls.filter((c) => c.startsWith('POST') && c.endsWith('/docs/PR'))).toEqual([]);
    expect(screen.queryByText(/ภาษีมูลค่าเพิ่ม/)).toBeNull(); // not a priced document: no VAT totals, no paper preview
  }, 30000);

  it('company switch: the other company\'s employees never show (a fresh editor for the new company, its own list)', async () => {
    const { qc } = ui();
    await screen.findByText('สมศรี บัญชีดี', undefined, { timeout: 8000 });
    const me = qc.getQueryData<Me>(qk.me())!;
    setSettings({ companyKey: 'nonvat' });
    act(() => { qc.setQueryData(qk.me(), { ...me, activeCompanyId: 'co-nonvat', vatRegistered: false }); });
    await screen.findByText('บุญมา ทำดี', undefined, { timeout: 8000 });
    expect(screen.queryByText('สมศรี บัญชีดี')).toBeNull();
    expect(screen.queryByText('ธนา เริ่มงานใหม่')).toBeNull();
    expect(qc.getQueryData([ 'co-vat', 'records', 'employee', 'picker', 'true' ])).toBeTruthy(); // company A's list is its own cache entry, never read for B
  }, 30000);
});
