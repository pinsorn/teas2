import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import type { ComputeResult, DocLine } from '@/domain/types';
import type { PostableAccount } from '@/lib/api/endpoints';
import { AccountLineGrid, accountLinePayload, isBlankAccountLine, newAccountLine } from './AccountLineGrid';

const ACCOUNTS: PostableAccount[] = [{ code: '5110', nameTh: 'ค่าเช่า', class: 'expense' }, { code: '2120', nameTh: 'ค่าใช้จ่ายค้างจ่าย', class: 'liability' }];
const line = (id: string, p: Partial<DocLine> = {}): DocLine => ({ ...newAccountLine(), id, ...p });

function Harness({ initial, balance }: { initial: DocLine[]; balance?: ComputeResult['balance'] }) {
  const [lines, setLines] = useState(initial);
  return <><AccountLineGrid lines={lines} onChange={setLines} accounts={ACCOUNTS} balance={balance} /><output data-testid="state">{JSON.stringify(lines.map((l) => [l.accountCode, l.debit, l.credit]))}</output></>;
}
const state = () => JSON.parse(screen.getByTestId('state').textContent!) as string[][];

describe('AccountLineGrid', () => {
  it('the balance text is the server\'s (compute.balance): the lines are never summed in the browser', () => {
    // the lines say 5.00 / 3.00; the server says 1,000.00 / 900.00 - only the server's figures are shown
    render(<Harness initial={[line('a', { accountCode: '5110', debit: '5.00' }), line('b', { accountCode: '2120', credit: '3.00' })]} balance={{ debit: '1000.00', credit: '900.00', diff: '100.00' }} />);
    expect(screen.getByTestId('jv-debit')).toHaveTextContent('1,000.00');
    expect(screen.getByTestId('jv-credit')).toHaveTextContent('900.00');
    expect(screen.getByTestId('jv-diff')).toHaveTextContent('100.00');
    expect(within(screen.getByRole('region', { name: 'ยอดรวมใบสำคัญ' })).getByText('ยอดเดบิตและเครดิตไม่เท่ากัน (ต่าง 100.00)')).toBeInTheDocument();
    expect(screen.queryByText('8.00')).not.toBeInTheDocument();
  });
  it('a balanced answer says so; no answer yet shows nothing (never a computed guess)', () => {
    const { rerender } = render(<AccountLineGrid lines={[line('a'), line('b')]} onChange={() => undefined} accounts={ACCOUNTS} balance={{ debit: '10.00', credit: '10.00', diff: '0.00' }} />);
    expect(within(screen.getByRole('region', { name: 'ยอดรวมใบสำคัญ' })).getByText('ยอดเดบิตและเครดิตเท่ากัน')).toBeInTheDocument();
    rerender(<AccountLineGrid lines={[line('a'), line('b')]} onChange={() => undefined} accounts={ACCOUNTS} />);
    expect(screen.getByTestId('jv-debit')).toHaveTextContent('');
  });
  it('type a code, Enter picks it and moves to the note; Enter walks note -> debit -> credit -> next row; Enter on the last credit adds a row', async () => {
    render(<Harness initial={[line('a'), line('b')]} />);
    await userEvent.click(screen.getByRole('combobox', { name: 'บัญชีรายการ 1' }));
    await userEvent.keyboard('5110{Enter}');
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'คำอธิบายรายการ 1' })).toHaveFocus());
    expect(state()[0][0]).toBe('5110');
    await userEvent.keyboard('{Enter}');
    expect(screen.getByRole('textbox', { name: 'เดบิตรายการ 1' })).toHaveFocus();
    await userEvent.keyboard('1500{Enter}');
    expect(screen.getByRole('textbox', { name: 'เครดิตรายการ 1' })).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(screen.getByRole('combobox', { name: 'บัญชีรายการ 2' })).toHaveFocus();
    await userEvent.keyboard('2120{Enter}');
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'คำอธิบายรายการ 2' })).toHaveFocus());
    await userEvent.keyboard('{Enter}{Enter}');
    await userEvent.keyboard('1500{Enter}'); // the credit of the last row
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'บัญชีรายการ 3' })).toHaveFocus());
    expect(state()).toEqual([['5110', '1500.00', ''], ['2120', '', '1500.00'], ['', '', '']]);
  });
  it('Tab straight after typing a whole account code selects it', async () => {
    render(<Harness initial={[line('a'), line('b')]} />);
    await userEvent.click(screen.getByRole('combobox', { name: 'บัญชีรายการ 1' }));
    await userEvent.keyboard('2120');
    await userEvent.tab();
    await waitFor(() => expect(state()[0][0]).toBe('2120'));
    expect(screen.getByRole('combobox', { name: 'บัญชีรายการ 1' })).toHaveValue('2120 ค่าใช้จ่ายค้างจ่าย');
  });
  it('one side only: typing a debit clears the credit and the other way round', async () => {
    render(<Harness initial={[line('a', { accountCode: '5110' }), line('b', { accountCode: '2120', credit: '90.00' })]} />);
    await userEvent.type(screen.getByRole('textbox', { name: 'เดบิตรายการ 2' }), '40');
    expect(state()[1]).toEqual(['2120', '40', '']);
    await userEvent.type(screen.getByRole('textbox', { name: 'เครดิตรายการ 2' }), '7');
    expect(state()[1]).toEqual(['2120', '', '7']);
  });
  it('an empty row is not a line; the wire format carries both sides as n.nn', () => {
    expect(isBlankAccountLine(newAccountLine())).toBe(true);
    expect(isBlankAccountLine(line('a', { accountCode: '5110' }))).toBe(false);
    expect(accountLinePayload(line('a', { accountCode: '5110', debit: '12' }))).toMatchObject({ debit: '12.00', credit: '0.00' });
  });
});
