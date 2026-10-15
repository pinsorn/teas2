import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { DocLine } from '@/domain/types';
import { LineGrid } from './LineGrid';

const empty: DocLine = { id: 'l1', description: '', qty: '1', unit: '', unitPrice: '0.00', taxCode: 'S7' };

describe('LineGrid keyboard', () => {
  it('Tab walks description → qty → price; Enter on the last cell adds a row', async () => {
    const onChange = vi.fn();
    render(<LineGrid lines={[empty]} onChange={onChange} searchItems={async () => []} />);
    await userEvent.click(screen.getByRole('combobox', { name: 'รายการ 1' }));
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
    fireEvent.paste(screen.getByRole('combobox', { name: 'รายการ 1' }), {
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

function Harness({ search }: { search: (q: string) => Promise<never[]> }) {
  const [lines, setLines] = useState([empty]);
  return <LineGrid lines={lines} onChange={setLines} searchItems={search} />;
}

describe('LineGrid — F3 debt', () => {
  it('pasted and typed prices produce the same price text (M9)', async () => {
    for (const raw of ['1.005', '8.345', '9007199254740993.50', '1,500']) {
      const first = render(<Harness search={async () => []} />);
      fireEvent.paste(screen.getByRole('combobox', { name: 'รายการ 1' }), { clipboardData: { getData: () => `งาน\t1\t${raw}` } });
      const pasted = (screen.getByRole('textbox', { name: 'ราคาต่อหน่วย 1' }) as HTMLInputElement).value;
      first.unmount();
      const second = render(<Harness search={async () => []} />);
      const price = screen.getByRole('textbox', { name: 'ราคาต่อหน่วย 1' });
      await userEvent.clear(price);
      await userEvent.type(price, raw);
      await userEvent.tab(); // blur normalises to the wire format
      expect(pasted, raw).toBe((price as HTMLInputElement).value);
      second.unmount();
    }
    // spot-check the shared rule itself so the loop cannot pass vacuously
    render(<Harness search={async () => []} />);
    fireEvent.paste(screen.getByRole('combobox', { name: 'รายการ 1' }), { clipboardData: { getData: () => 'งาน\t1\t8.345' } });
    expect(screen.getByRole('textbox', { name: 'ราคาต่อหน่วย 1' })).toHaveValue('8.34');
  });
  it('Enter on an unmatched description commits free text and moves to the qty cell (T11)', async () => {
    // fast Enter: pressed before the debounced search has answered, and the answer is "no match"
    render(<Harness search={() => new Promise((r) => setTimeout(() => r([]), 40))} />);
    await userEvent.type(screen.getByRole('combobox', { name: 'รายการ 1' }), 'ของใหม่ไม่มีในรายการ{Enter}');
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'จำนวน 1' })).toHaveFocus());
    expect(screen.getByRole('combobox', { name: 'รายการ 1' })).toHaveValue('ของใหม่ไม่มีในรายการ');
  });
});
