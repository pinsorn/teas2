import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChecklistItem, PeriodMonth, PeriodsView } from '@/domain/types';
import { ChecklistPanel } from './ChecklistPanel';
import { PeriodGrid } from './PeriodGrid';
import { ReopenDialog } from './ReopenDialog';

vi.mock('next/navigation', () => import('@/test/next-navigation'));
afterEach(cleanup);

const month = (m: string, over: Partial<PeriodMonth> = {}): PeriodMonth => ({ month: m, status: 'open', acknowledged: [], reopened: [], inClosedYear: false, ...over });
const view = (over: Partial<PeriodsView> = {}): PeriodsView => ({
  year: 2026, years: [2025, 2026], yearReopened: [], next: { close: '2026-08', reopen: '2026-07', closeYear: false, reopenYear: false },
  months: [month('2026-06', { status: 'closed', closedAt: '2026-07-10T09:00:00+07:00', closedBy: 'สมศรี' }),
    month('2026-07', { status: 'closed', closedAt: '2026-08-10T09:00:00+07:00', closedBy: 'สมศรี', reopened: [{ at: '2026-08-01T00:00:00Z', reason: 'พบรายการตกหล่น', by: 'สมศรี' }] }), month('2026-08')], ...over,
});
const item = (code: ChecklistItem['code'], severity: ChecklistItem['severity'], count: number): ChecklistItem => ({ code, severity, count, labelTh: `ข้อ ${code}`, href: `/go/${code}` });

describe('PeriodGrid', () => {
  it('offers check on the next open month and reopen on the latest closed one only; the history shows the reason', async () => {
    const onSelect = vi.fn(), onReopen = vi.fn();
    render(<PeriodGrid view={view()} canReopen onSelect={onSelect} onReopen={onReopen} />);
    expect(screen.getAllByRole('button', { name: /^เปิด .* อีกครั้ง$/ })).toHaveLength(1);
    expect(within(screen.getByTestId('period-2026-07')).getByRole('button', { name: /อีกครั้ง/ })).toBeTruthy();
    expect(within(screen.getByTestId('period-2026-07')).getByText(/พบรายการตกหล่น/)).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /^ตรวจสอบและปิด/ })).toHaveLength(1);
    await userEvent.click(within(screen.getByTestId('period-2026-08')).getByRole('button', { name: /ตรวจสอบและปิด/ }));
    expect(onSelect).toHaveBeenCalledWith('2026-08');
    await userEvent.click(within(screen.getByTestId('period-2026-07')).getByRole('button', { name: /อีกครั้ง/ }));
    expect(onReopen).toHaveBeenCalledWith('2026-07');
  });
  it('disables reopen without the permission', () => {
    render(<PeriodGrid view={view()} canReopen={false} onSelect={vi.fn()} onReopen={vi.fn()} />);
    expect((within(screen.getByTestId('period-2026-07')).getByRole('button', { name: /อีกครั้ง/ }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('ChecklistPanel', () => {
  const base = { month: '2026-08', canClose: true, isNext: true, acknowledged: false, onAcknowledged: vi.fn(), pending: false, error: undefined, onClose: vi.fn() };
  it('links a blocking item to its exit and asks for the tick only when a warning is open', async () => {
    const onAck = vi.fn();
    render(<ChecklistPanel {...base} onAcknowledged={onAck} items={[item('depreciation_not_run', 'blocking', 2), item('drafts_in_month', 'warning', 3), item('schedules_not_run', 'warning', 0)]} />);
    expect(screen.getByTestId('check-depreciation_not_run').querySelector('a')?.getAttribute('href')).toBe('/go/depreciation_not_run');
    expect(screen.getByTestId('check-schedules_not_run').querySelector('a')).toBeNull(); // nothing to fix
    await userEvent.click(screen.getByRole('checkbox'));
    expect(onAck).toHaveBeenCalledWith(true);
  });
  it('shows no tick when only blocking or nothing is open, and the close button asks the server', async () => {
    const onClose = vi.fn();
    render(<ChecklistPanel {...base} onClose={onClose} items={[item('depreciation_not_run', 'blocking', 1)]} />);
    expect(screen.queryByRole('checkbox')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /^ปิดงวด/ }));
    expect(onClose).toHaveBeenCalled();
  });
  it('needs ledger.period.close; a month that is not the next one cannot close', () => {
    const { rerender } = render(<ChecklistPanel {...base} canClose={false} items={[]} />);
    expect((screen.getByRole('button', { name: /^ปิดงวด/ }) as HTMLButtonElement).disabled).toBe(true);
    rerender(<ChecklistPanel {...base} isNext={false} items={[]} />);
    expect(screen.queryByRole('button', { name: /^ปิดงวด/ })).toBeNull();
  });
  it('a closed month shows what was accepted at close, frozen', () => {
    render(<ChecklistPanel {...base} isNext={false} items={[]} period={month('2026-07', { status: 'closed', closedAt: '2026-08-10T09:00:00+07:00', closedBy: 'สมศรี', acknowledged: [item('drafts_in_month', 'warning', 3)] })} />);
    expect(screen.getByTestId('count-drafts_in_month').textContent).toBe('3 รายการ');
    expect(screen.queryByRole('button', { name: /^ปิดงวด/ })).toBeNull();
  });
});

describe('ReopenDialog', () => {
  it('confirms only with a reason', async () => {
    const onConfirm = vi.fn();
    render(<ReopenDialog title="เปิดงวด" body="x" pending={false} error={undefined} onConfirm={onConfirm} onClose={vi.fn()} />);
    const ok = screen.getByRole('button', { name: 'เปิดคืน' }) as HTMLButtonElement;
    expect(ok.disabled).toBe(true);
    await userEvent.type(screen.getByLabelText('เหตุผลที่เปิดคืน'), 'ผู้สอบบัญชีขอ');
    await userEvent.click(ok);
    expect(onConfirm).toHaveBeenCalledWith('ผู้สอบบัญชีขอ');
  });
});
