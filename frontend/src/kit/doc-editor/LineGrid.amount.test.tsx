import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { DocLine, ItemSummary } from '@/domain/types';
import { LineGrid } from './LineGrid';

const blank: DocLine = { id: 'l1', description: '', qty: '1', unit: '', unitPrice: '0.00', taxCode: 'S7' };
const WHT = [{ code: 'SVC', nameTh: 'ค่าบริการ', rate: '3%', incomeType: '40(8)' }, { code: 'RENT', nameTh: 'ค่าเช่า', rate: '5%', incomeType: '40(5)' }];
const svc: ItemSummary = { id: 'SV-01', code: 'SV-01', name: 'ถ่ายภาพ', kind: 'service', unit: 'งาน', unitPrice: '5000.00', taxCode: 'EX', whtTypeCode: 'SVC' };

function Host({ lines = [blank], spy, ...rest }: { lines?: DocLine[]; spy?: (l: DocLine[]) => void } & Partial<Parameters<typeof LineGrid>[0]>) {
  const [v, setV] = useState(lines);
  return <LineGrid lines={v} onChange={(l) => { setV(l); spy?.(l); }} searchItems={async (q) => (q ? [svc] : [])} variant="amount" {...rest} />;
}

describe('LineGrid amount editor (RC / PV)', () => {
  it('columns: description, amount and tax only; no quantity or unit-price inputs', () => {
    render(<Host />);
    expect(screen.getByRole('combobox', { name: 'รายการ 1' })).toBeVisible();
    expect(screen.getByRole('textbox', { name: 'จำนวนเงินรายการ 1' })).toBeVisible();
    expect(screen.getByRole('combobox', { name: 'ภาษีรายการ 1' })).toHaveValue('S7');
    expect(screen.queryByRole('textbox', { name: 'จำนวน 1' })).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'ราคาต่อหน่วย 1' })).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'หมวดค่าใช้จ่ายรายการ 1' })).toBeNull(); // category only for a vendor / employee party
    expect(screen.queryByRole('combobox', { name: 'หัก ณ ที่จ่ายรายการ 1' })).toBeNull(); // withholding only when the document withholds
  });
  it('the category column appears for a vendor or employee party; the WHT column lists the server types', async () => {
    const spy = vi.fn();
    render(<Host showCategory whtTypes={WHT} spy={spy} />);
    await userEvent.type(screen.getByRole('textbox', { name: 'หมวดค่าใช้จ่ายรายการ 1' }), 'ค่าจ้างช่างภาพ');
    expect(spy).toHaveBeenLastCalledWith([expect.objectContaining({ expenseCategory: 'ค่าจ้างช่างภาพ' })]);
    const wht = screen.getByRole('combobox', { name: 'หัก ณ ที่จ่ายรายการ 1' });
    expect(within(wht).getAllByRole('option').map((o) => o.textContent)).toEqual(['ไม่หัก', 'ค่าบริการ 3%', 'ค่าเช่า 5%']);
    await userEvent.selectOptions(wht, 'SVC');
    expect(spy).toHaveBeenLastCalledWith([expect.objectContaining({ whtTypeCode: 'SVC' })]);
    await userEvent.selectOptions(wht, '');
    expect(spy.mock.lastCall![0][0].whtTypeCode).toBeUndefined();
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'ภาษีรายการ 1' }), 'EX');
    expect(spy).toHaveBeenLastCalledWith([expect.objectContaining({ taxCode: 'EX' })]);
  });
  it('the amount is typed money kept as text (qty stays 1); Enter walks description > category > amount and adds a row at the end', async () => {
    const spy = vi.fn();
    render(<Host showCategory spy={spy} />);
    await userEvent.click(screen.getByRole('combobox', { name: 'รายการ 1' }));
    await userEvent.keyboard('{Enter}');
    expect(screen.getByRole('textbox', { name: 'หมวดค่าใช้จ่ายรายการ 1' })).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    const amount = screen.getByRole('textbox', { name: 'จำนวนเงินรายการ 1' });
    expect(amount).toHaveFocus();
    await userEvent.keyboard('1234.567');
    expect(amount).toHaveValue('1234.56'); // 2 dp, no float
    await userEvent.keyboard('{Enter}');
    expect(spy.mock.lastCall![0]).toHaveLength(2);
    expect(spy.mock.lastCall![0][0]).toMatchObject({ unitPrice: '1234.56', qty: '1' });
    expect(screen.getByRole('combobox', { name: 'รายการ 2' })).toHaveFocus();
  });
  it('picking an item copies its price and tax, and its WHT type when the document withholds', async () => {
    const spy = vi.fn();
    render(<Host whtTypes={WHT} spy={spy} />);
    await userEvent.type(screen.getByRole('combobox', { name: 'รายการ 1' }), 'ถ');
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(spy.mock.lastCall![0][0]).toMatchObject({ itemId: 'SV-01', unitPrice: '5000.00', taxCode: 'EX', whtTypeCode: 'SVC' }));
    expect(await screen.findByRole('textbox', { name: 'จำนวนเงินรายการ 1' })).toHaveFocus();
  });
  it('without a WHT column a picked item does not carry a WHT type (a receipt cash bill)', async () => {
    const spy = vi.fn();
    render(<Host spy={spy} />);
    await userEvent.type(screen.getByRole('combobox', { name: 'รายการ 1' }), 'ถ');
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(spy.mock.lastCall![0][0].itemId).toBe('SV-01'));
    expect(spy.mock.lastCall![0][0].whtTypeCode).toBeUndefined();
  });
  it('WHT type list failed to load: the column shows the error with a retry, never "no withholding"', async () => {
    const retry = vi.fn();
    render(<Host whtTypes={[]} whtError={new Error('x')} onWhtRetry={retry} />);
    expect(screen.queryByRole('combobox', { name: 'หัก ณ ที่จ่ายรายการ 1' })).toBeNull();
    expect(screen.queryByRole('option', { name: 'ไม่หัก' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'ลองใหม่' }));
    expect(retry).toHaveBeenCalled();
  });
  it('a saved WHT code that the list does not know shows as an error option, not as "none"', () => {
    render(<Host lines={[{ ...blank, whtTypeCode: 'GONE' }]} whtTypes={WHT} />);
    const wht = screen.getByRole('combobox', { name: 'หัก ณ ที่จ่ายรายการ 1' });
    expect(wht).toHaveValue('GONE');
    expect(wht).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('option', { name: 'ไม่พบประเภท GONE' })).toBeInTheDocument();
  });
  it('a voucher grid (exemptOnly) offers only the no-VAT tax code and forces it on a picked item', async () => {
    const spy = vi.fn();
    render(<Host exemptOnly whtTypes={WHT} lines={[{ ...blank, taxCode: 'EX' }]} spy={spy} />);
    expect(within(screen.getByRole('combobox', { name: 'ภาษีรายการ 1' })).getAllByRole('option').map((o) => o.textContent)).toEqual(['ไม่มี VAT / ยกเว้น']);
    await userEvent.type(screen.getByRole('combobox', { name: 'รายการ 1' }), 'ถ');
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(spy.mock.lastCall![0][0].itemId).toBe('SV-01'));
    expect(spy.mock.lastCall![0][0].taxCode).toBe('EX');
  });
});
