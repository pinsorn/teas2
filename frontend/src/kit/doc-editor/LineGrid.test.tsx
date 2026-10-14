import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { DocLine } from '@/domain/types';
import { LineGrid } from './LineGrid';

const empty: DocLine = { id: 'l1', description: '', qty: '1', unit: '', unitPrice: '0.00', taxCode: 'S7' };

describe('LineGrid keyboard', () => {
  it('Tab walks description → qty → price; Enter on the last cell adds a row', async () => {
    const onChange = vi.fn();
    render(<LineGrid lines={[empty]} onChange={onChange} searchItems={async () => []} />);
    await userEvent.click(screen.getByRole('textbox', { name: 'รายการ 1' }));
    await userEvent.tab();
    expect(screen.getByRole('textbox', { name: 'จำนวน 1' })).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByRole('textbox', { name: 'ราคาต่อหน่วย 1' })).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(onChange).toHaveBeenLastCalledWith(expect.arrayContaining([expect.objectContaining({ id: 'l1' }), expect.objectContaining({ description: '' })]));
    expect(onChange.mock.lastCall![0]).toHaveLength(2);
  });
  it('pasting rows from a spreadsheet creates lines', () => {
    const onChange = vi.fn();
    render(<LineGrid lines={[empty]} onChange={onChange} searchItems={async () => []} />);
    fireEvent.paste(screen.getByRole('textbox', { name: 'รายการ 1' }), {
      clipboardData: { getData: () => 'ค่าออกแบบ\t2\t1500\nค่าพิมพ์\t100\t8.50' },
    });
    expect(onChange).toHaveBeenLastCalledWith([
      expect.objectContaining({ description: 'ค่าออกแบบ', qty: '2', unitPrice: '1500.00' }),
      expect.objectContaining({ description: 'ค่าพิมพ์', qty: '100', unitPrice: '8.50' }),
    ]);
  });
  it('Enter in a middle cell moves on without adding a row', async () => {
    const onChange = vi.fn();
    render(<LineGrid lines={[empty]} onChange={onChange} searchItems={async () => []} />);
    await userEvent.click(screen.getByRole('textbox', { name: 'จำนวน 1' }));
    await userEvent.keyboard('{Enter}');
    expect(screen.getByRole('textbox', { name: 'ราคาต่อหน่วย 1' })).toHaveFocus();
    expect(onChange).not.toHaveBeenCalled();
  });
});
