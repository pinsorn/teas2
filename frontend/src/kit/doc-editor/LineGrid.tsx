'use client';
import { PlusIcon, Trash2Icon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, type ClipboardEvent, type KeyboardEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ErrorState } from '../states/ErrorState';
import type { DocLine, ItemSummary, Money, TaxCode } from '@/domain/types';
import type { WhtTypeRef } from '@/lib/api/endpoints';
import { formatMoney } from '@/lib/format';
import { ItemField } from './ItemField';
import { AMOUNT_ORDER, cleanDecimal, isComposing, moneyText, nextCell, parseClipboardRows, qtyText, type Cell } from './useLineGridKeys';

export const newLine = (taxCode: DocLine['taxCode'] = 'S7'): DocLine =>
  ({ id: crypto.randomUUID(), description: '', qty: '1', unit: '', unitPrice: '0.00', taxCode });
export const isBlankLine = (l: DocLine) => !l.description.trim() && /^0*\.?0*$/.test(l.unitPrice);

const COLS = 'md:grid-cols-[minmax(0,1fr)_6rem_9rem_9rem_var(--ctl-h)]';
// amount editor: description | [category] | amount | tax | [withholding] | remove (static class strings: Tailwind cannot see built ones)
const AMT_COLS: Record<string, string> = {
  '00': 'md:grid-cols-[minmax(0,1fr)_9rem_9rem_var(--ctl-h)]',
  '10': 'md:grid-cols-[minmax(0,1fr)_10rem_9rem_9rem_var(--ctl-h)]',
  '01': 'md:grid-cols-[minmax(0,1fr)_9rem_9rem_11rem_var(--ctl-h)]',
  '11': 'md:grid-cols-[minmax(0,1fr)_10rem_9rem_9rem_11rem_var(--ctl-h)]',
};
const TAX_CODES: TaxCode[] = ['S7', 'Z0', 'EX'];
const select = 'h-(--ctl-h) w-full rounded-lg border border-input bg-card px-2 text-body outline-none';

export interface LineGridProps {
  lines: DocLine[];
  onChange: (lines: DocLine[]) => void;
  searchItems: (q: string) => Promise<ItemSummary[]>;
  /** Per-line net from the compute endpoint (display only). */
  amounts?: Record<string, Money>;
  computing?: boolean;
  /** 'amount' = the RC / PV editor: description, [category], amount, tax, [withholding] (SP0 5.11); default 'item' = qty x price. */
  variant?: 'item' | 'amount';
  /** amount editor: show the expense-category column (the party is a vendor or an employee). */
  showCategory?: boolean;
  /** amount editor: when given, the withholding column lists these types (the document withholds tax). */
  whtTypes?: WhtTypeRef[];
  /** amount editor: the WHT type list failed to load (retry shown in the column; never rendered as "no withholding"). */
  whtError?: unknown;
  onWhtRetry?: () => void;
  /** amount editor of a voucher: input VAT only comes through a bill, so lines are exempt-only. */
  exemptOnly?: boolean;
}

export function LineGrid({ lines, onChange, searchItems, amounts, computing, variant = 'item', showCategory = false, whtTypes, whtError, onWhtRetry, exemptOnly = false }: LineGridProps) {
  const t = useTranslations('docEditor.lines');
  const root = useRef<HTMLDivElement>(null);
  const focusReq = useRef<{ row: number; cell: Cell } | null>(null);

  const amountMode = variant === 'amount';
  const whtLoading = whtTypes?.length === 0 && !whtError; // the list is still on its way: nothing is offered yet, and a saved code is not judged unknown
  const focus = (row: number, cell: Cell) => root.current?.querySelector<HTMLElement>(`[data-cell="${row}:${cell}"]`)?.focus();
  useEffect(() => {
    if (!focusReq.current) return;
    focus(focusReq.current.row, focusReq.current.cell);
    focusReq.current = null;
  });

  const patch = (i: number, p: Partial<DocLine>) => onChange(lines.map((l, k) => (k === i ? { ...l, ...p } : l)));
  const move = (i: number, cell: Cell, back: boolean) => {
    const n = nextCell(i, cell, lines.length, back, amountMode ? AMOUNT_ORDER(showCategory) : undefined);
    if (n === 'add-row') { focusReq.current = { row: lines.length, cell: 'description' }; onChange([...lines, newLine(lines[i].taxCode)]); }
    else if (n) focus(n.row, n.cell);
  };
  const onCellKey = (e: KeyboardEvent<HTMLInputElement>, i: number, cell: Cell) => {
    if (e.key !== 'Enter' || isComposing(e) || e.ctrlKey || e.metaKey || e.altKey) return;
    e.preventDefault();
    move(i, cell, e.shiftKey);
  };
  const onPaste = (e: ClipboardEvent<HTMLInputElement>, i: number) => {
    const text = e.clipboardData.getData('text');
    if (!/[\t\n]/.test(text.trim())) return; // one plain value: normal paste
    const rows = parseClipboardRows(text);
    if (!rows.length) return;
    e.preventDefault();
    const blank = isBlankLine(lines[i]);
    const made = rows.map((r, k): DocLine => ({ ...newLine(lines[i].taxCode), ...(blank && k === 0 ? { id: lines[i].id } : {}), description: r.description, qty: amountMode ? '1' : qtyText(r.qty), unitPrice: r.unitPrice }));
    onChange([...lines.slice(0, blank ? i : i + 1), ...made, ...lines.slice(i + 1)]);
  };
  const pick = (i: number, it: ItemSummary) => {
    focusReq.current = { row: i, cell: amountMode ? 'unitPrice' : 'qty' };
    patch(i, { itemId: it.id, description: it.name, unit: it.unit, unitPrice: moneyText(it.unitPrice), taxCode: exemptOnly ? 'EX' : it.taxCode, ...(amountMode && whtTypes && it.whtTypeCode ? { whtTypeCode: it.whtTypeCode } : {}) });
  };
  const remove = (i: number) => onChange(lines.filter((_, k) => k !== i));

  const amtCols = AMT_COLS[`${showCategory ? 1 : 0}${whtTypes ? 1 : 0}`];
  const addRow = () => { focusReq.current = { row: lines.length, cell: 'description' }; onChange([...lines, newLine(lines.at(-1)?.taxCode)]); };

  if (amountMode) {
    return (
      <div ref={root} className="grid gap-3">
        <div aria-hidden className={`hidden gap-2 px-0 text-small font-medium text-muted-foreground md:grid ${amtCols}`}>
          <span>{t('colDescription')}</span>{showCategory && <span>{t('colCategory')}</span>}
          <span className="text-right">{t('colAmountInput')}</span><span>{t('colTax')}</span>{whtTypes && <span>{t('colWht')}</span>}<span />
        </div>
        {lines.map((l, i) => {
          const n = i + 1;
          return (
            <div key={l.id} className={`grid grid-cols-2 items-start gap-2 rounded-lg border border-border p-3 md:border-0 md:p-0 ${amtCols}`}>
              <div className="col-span-2 md:col-span-1">
                <ItemField value={l.description} label={t('description', { n })} cell={`${i}:description`} search={searchItems}
                  onText={(description) => patch(i, { description, itemId: undefined })} onPick={(it) => pick(i, it)}
                  onKey={(e) => onCellKey(e, i, 'description')} onPaste={(e) => onPaste(e, i)} onAdvance={(back) => move(i, 'description', back)} />
              </div>
              {showCategory && (
                <label className="grid gap-1">
                  <span aria-hidden className="text-small text-muted-foreground md:hidden">{t('colCategory')}</span>
                  <Input type="text" autoComplete="off" aria-label={t('category', { n })} data-cell={`${i}:category`} value={l.expenseCategory ?? ''}
                    onChange={(e) => patch(i, { expenseCategory: e.target.value || undefined })} onKeyDown={(e) => onCellKey(e, i, 'category')} />
                </label>
              )}
              <label className="grid gap-1">
                <span aria-hidden className="text-small text-muted-foreground md:hidden">{t('colAmountInput')}</span>
                <Input type="text" inputMode="decimal" autoComplete="off" aria-label={t('amountInput', { n })} data-cell={`${i}:unitPrice`}
                  className="text-right tabular-nums" value={l.unitPrice}
                  onChange={(e) => patch(i, { unitPrice: cleanDecimal(e.target.value, 2), qty: '1' })}
                  onBlur={() => { if (moneyText(l.unitPrice) !== l.unitPrice) patch(i, { unitPrice: moneyText(l.unitPrice) }); }} onFocus={(e) => e.target.select()}
                  onKeyDown={(e) => onCellKey(e, i, 'unitPrice')} />
              </label>
              <label className="grid gap-1">
                <span aria-hidden className="text-small text-muted-foreground md:hidden">{t('colTax')}</span>
                <select aria-label={t('tax', { n })} className={select} value={l.taxCode} onChange={(e) => patch(i, { taxCode: e.target.value as TaxCode })}>
                  {(exemptOnly ? (['EX'] as TaxCode[]) : TAX_CODES).map((c) => <option key={c} value={c}>{t(`taxCode.${c}`)}</option>)}
                </select>
              </label>
              {whtTypes && (
                <div className="grid gap-1">
                  <span aria-hidden className="text-small text-muted-foreground md:hidden">{t('colWht')}</span>
                  {whtError ? <ErrorState error={whtError} onRetry={() => onWhtRetry?.()} /> : (
                    <select aria-label={t('wht', { n })} className={select} value={l.whtTypeCode ?? ''} disabled={whtTypes.length === 0 && !l.whtTypeCode && whtLoading}
                      aria-invalid={!!l.whtTypeCode && !whtLoading && !whtTypes.some((w) => w.code === l.whtTypeCode)}
                      onChange={(e) => patch(i, { whtTypeCode: e.target.value || undefined })}>
                      <option value="">{t('whtNone')}</option>
                      {l.whtTypeCode && !whtLoading && !whtTypes.some((w) => w.code === l.whtTypeCode) && <option value={l.whtTypeCode}>{t('whtUnknown', { code: l.whtTypeCode })}</option>}
                      {whtTypes.map((w) => <option key={w.code} value={w.code}>{`${w.nameTh} ${w.rate}`}</option>)}
                    </select>
                  )}
                </div>
              )}
              <Button type="button" variant="ghost" size="icon" aria-label={t('remove', { n })} disabled={lines.length === 1}
                className="justify-self-end md:justify-self-auto" onClick={() => remove(i)}>
                <Trash2Icon aria-hidden />
              </Button>
            </div>
          );
        })}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Button type="button" variant="outline" onClick={addRow}><PlusIcon aria-hidden data-icon="inline-start" />{t('add')}</Button>
          <p className="text-small text-muted-foreground">{t('hintAmount')}</p>
        </div>
      </div>
    );
  }

  return (
    <div ref={root} className="grid gap-3">
      <div aria-hidden className={`hidden gap-2 px-0 text-small font-medium text-muted-foreground md:grid ${COLS}`}>
        <span>{t('colDescription')}</span><span className="text-right">{t('colQty')}</span>
        <span className="text-right">{t('colPrice')}</span><span className="text-right">{t('colAmount')}</span><span />
      </div>
      {lines.map((l, i) => {
        const n = i + 1;
        return (
          <div key={l.id} className={`grid grid-cols-2 items-start gap-2 rounded-lg border border-border p-3 md:border-0 md:p-0 ${COLS}`}>
            <div className="col-span-2 md:col-span-1">
              <ItemField value={l.description} label={t('description', { n })} cell={`${i}:description`} search={searchItems}
                onText={(description) => patch(i, { description, itemId: undefined })} onPick={(it) => pick(i, it)}
                onKey={(e) => onCellKey(e, i, 'description')} onPaste={(e) => onPaste(e, i)} onAdvance={(back) => move(i, 'description', back)} />
            </div>
            <label className="grid gap-1">
              <span aria-hidden className="text-small text-muted-foreground md:hidden">{t('colQty')}</span>
              <Input type="text" inputMode="decimal" autoComplete="off" aria-label={t('qty', { n })} data-cell={`${i}:qty`}
                className="text-right tabular-nums" value={l.qty}
                onChange={(e) => patch(i, { qty: cleanDecimal(e.target.value, 4) })}
                onBlur={() => { if (qtyText(l.qty) !== l.qty) patch(i, { qty: qtyText(l.qty) }); }} onFocus={(e) => e.target.select()}
                onKeyDown={(e) => onCellKey(e, i, 'qty')} />
            </label>
            <label className="grid gap-1">
              <span aria-hidden className="text-small text-muted-foreground md:hidden">{t('colPrice')}</span>
              <Input type="text" inputMode="decimal" autoComplete="off" aria-label={t('price', { n })} data-cell={`${i}:unitPrice`}
                className="text-right tabular-nums" value={l.unitPrice}
                onChange={(e) => patch(i, { unitPrice: cleanDecimal(e.target.value, 2) })}
                onBlur={() => { if (moneyText(l.unitPrice) !== l.unitPrice) patch(i, { unitPrice: moneyText(l.unitPrice) }); }} onFocus={(e) => e.target.select()}
                onKeyDown={(e) => onCellKey(e, i, 'unitPrice')} />
            </label>
            <div className="grid gap-1">
              <span aria-hidden className="text-small text-muted-foreground md:hidden">{t('colAmount')}</span>
              <div className="flex h-(--ctl-h) items-center justify-end tabular-nums">
                {amounts?.[l.id] ? formatMoney(amounts[l.id]) : computing ? '…' : ''}
              </div>
            </div>
            <Button type="button" variant="ghost" size="icon" aria-label={t('remove', { n })} disabled={lines.length === 1}
              className="justify-self-end md:justify-self-auto" onClick={() => remove(i)}>
              <Trash2Icon aria-hidden />
            </Button>
          </div>
        );
      })}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button type="button" variant="outline" onClick={() => { focusReq.current = { row: lines.length, cell: 'description' }; onChange([...lines, newLine(lines.at(-1)?.taxCode)]); }}>
          <PlusIcon aria-hidden data-icon="inline-start" />{t('add')}
        </Button>
        <p className="text-small text-muted-foreground">{t('hint')}</p>
      </div>
    </div>
  );
}
