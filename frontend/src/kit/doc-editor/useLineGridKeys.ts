import type { KeyboardEvent } from 'react';

export type Cell = 'description' | 'qty' | 'unitPrice' | 'category';
const ORDER: Cell[] = ['description', 'qty', 'unitPrice'];
/** The amount editor (RC / PV): description, the optional expense category, then the amount (stored in unitPrice, qty is always 1). */
export const AMOUNT_ORDER = (category: boolean): Cell[] => (category ? ['description', 'category', 'unitPrice'] : ['description', 'unitPrice']);

export function nextCell(row: number, cell: Cell, rows: number, back = false, order: Cell[] = ORDER): { row: number; cell: Cell } | 'add-row' | null {
  const i = order.indexOf(cell) + (back ? -1 : 1);
  if (i >= 0 && i < order.length) return { row, cell: order[i] };
  if (!back && row + 1 < rows) return { row: row + 1, cell: order[0] };
  if (!back) return 'add-row';
  return row > 0 ? { row: row - 1, cell: order[order.length - 1] } : null;
}

export const isComposing = (e: KeyboardEvent) => e.nativeEvent.isComposing || e.keyCode === 229;

export function parseClipboardRows(text: string): { description: string; qty: string; unitPrice: string }[] {
  return text.trim().split(/\r?\n/).map((row) => {
    const [description = '', qty = '1', price = '0'] = row.split('\t');
    return { description: description.trim(), qty: qty.trim() || '1', unitPrice: moneyText(price) }; // same rule as typed text (truncate to 2 dp, string only: no float round-trip)
  }).filter((r) => r.description);
}

/** Typed money/quantity text: digits and one dot, at most `dp` decimals. Display-side input hygiene, not arithmetic. */
export const cleanDecimal = (s: string, dp: number) => {
  const [i = '', ...rest] = s.replace(/,/g, '').replace(/[^\d.]/g, '').split('.');
  return rest.length ? `${i}.${rest.join('').slice(0, dp)}` : i;
};
/** Wire format for money: always `n.nn` (the server rejects "12." or ""). */
export const moneyText = (s: string) => {
  const c = cleanDecimal(s, 2);
  const [i = '', f = ''] = c.split('.');
  return `${i || '0'}.${(f + '00').slice(0, 2)}`;
};
export const qtyText = (s: string) => {
  const c = cleanDecimal(s, 4);
  return c.replace(/\.$/, '') || '0';
};
