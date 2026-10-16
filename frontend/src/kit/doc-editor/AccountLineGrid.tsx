'use client';
import { PlusIcon, Trash2Icon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { ComputeResult, DocLine } from '@/domain/types';
import type { PostableAccount } from '@/lib/api/endpoints';
import { formatMoney } from '@/lib/format';
import { SuggestList, useSuggest } from './ItemField';
import { cleanDecimal, isComposing, moneyText } from './useLineGridKeys';

/** An account line of a journal voucher (AC1): the account, a note, ONE of debit / credit. The filler fields are what every document line carries. */
export const newAccountLine = (): DocLine =>
  ({ id: crypto.randomUUID(), description: '', qty: '1', unit: '', unitPrice: '0.00', taxCode: 'EX', accountCode: '', debit: '', credit: '' });
const zero = (m?: string) => !m || /^0*\.?0*$/.test(m);
/** An empty row is never sent (no account, no note, no amount). */
export const isBlankAccountLine = (l: DocLine) => !l.accountCode && !l.description.trim() && zero(l.debit) && zero(l.credit);
/** Wire format: both sides present as `n.nn`, the one not used `0.00`. */
export const accountLinePayload = (l: DocLine): DocLine => ({ ...l, accountCode: l.accountCode ?? '', debit: moneyText(l.debit ?? ''), credit: moneyText(l.credit ?? '') });

type Cell = 'account' | 'description' | 'debit' | 'credit';
const ORDER: Cell[] = ['account', 'description', 'debit', 'credit'];
const COLS = 'md:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_9rem_9rem_var(--ctl-h)]';

export interface AccountLineGridProps {
  lines: DocLine[];
  onChange: (lines: DocLine[]) => void;
  /** The accounts a JV may post to (the server's list). */
  accounts: PostableAccount[];
  /** Σ debit / Σ credit / difference as the server computed them: shown, never summed here. */
  balance?: ComputeResult['balance'];
  computing?: boolean;
}

function AccountCell({ line, label, cell, accounts, nameOf, onClear, onPick, onKey, onAdvance }: {
  line: DocLine; label: string; cell: string; accounts: PostableAccount[]; nameOf: (code: string) => string | undefined;
  onClear: () => void; onPick: (a: PostableAccount, focusNext: boolean) => void; onKey: (e: KeyboardEvent<HTMLInputElement>) => void; onAdvance: (back: boolean) => void;
}) {
  const [typed, setTyped] = useState('');
  const search = async (q: string) => { const n = q.trim().toLowerCase(); return accounts.filter((a) => a.code.startsWith(n) || a.nameTh.toLowerCase().includes(n)).slice(0, 8); };
  const s = useSuggest<PostableAccount>(search, (a) => { setTyped(''); onPick(a, true); }, onAdvance);
  const code = line.accountCode ?? '';
  const shown = code ? `${code} ${nameOf(code) ?? ''}`.trim() : typed;
  return (
    <div className="relative">
      <Input type="text" role="combobox" autoComplete="off" aria-autocomplete="list" aria-label={label} data-cell={cell} value={shown}
        aria-expanded={s.expanded} aria-controls={s.expanded ? s.listId : undefined} aria-activedescendant={s.expanded ? s.optionId(s.active) : undefined}
        onChange={(e) => { setTyped(e.target.value); if (code) onClear(); s.query(e.target.value); }}
        onKeyDown={(e) => { if (!s.onKeyDown(e)) onKey(e); }}
        onFocus={(e) => e.target.select()}
        onBlur={() => { s.blur(); const hit = !code ? accounts.find((a) => a.code === typed.trim()) : undefined; if (hit) { setTyped(''); onPick(hit, false); } }} /> {/* Tab straight after typing a whole code selects it */}
      <SuggestList s={s} label={label} render={(a) => <span className="flex items-baseline justify-between gap-3"><span>{a.nameTh}</span><span className="shrink-0 text-small text-muted-foreground tabular-nums">{a.code}</span></span>} />
    </div>
  );
}

/** The account-line editor of a journal voucher: account type-ahead, note, debit, credit. Tab and Enter walk account → note → debit → credit → the next row (Enter on the last cell adds a row). The balance under the rows is the server's. */
export function AccountLineGrid({ lines, onChange, accounts, balance, computing }: AccountLineGridProps) {
  const t = useTranslations('docEditor.accountGrid');
  const root = useRef<HTMLDivElement>(null);
  const focusReq = useRef<{ row: number; cell: Cell } | null>(null);
  const focus = (row: number, cell: Cell) => root.current?.querySelector<HTMLElement>(`[data-cell="${row}:${cell}"]`)?.focus();
  useEffect(() => { if (focusReq.current) { focus(focusReq.current.row, focusReq.current.cell); focusReq.current = null; } });

  const nameOf = (code: string) => accounts.find((a) => a.code === code)?.nameTh;
  const patch = (i: number, p: Partial<DocLine>) => onChange(lines.map((l, k) => (k === i ? { ...l, ...p } : l)));
  const addRow = () => { focusReq.current = { row: lines.length, cell: 'account' }; onChange([...lines, newAccountLine()]); };
  const move = (i: number, cell: Cell, back: boolean) => {
    const at = ORDER.indexOf(cell) + (back ? -1 : 1);
    if (at >= 0 && at < ORDER.length) focus(i, ORDER[at]);
    else if (!back && i + 1 < lines.length) focus(i + 1, ORDER[0]);
    else if (!back) addRow();
    else if (i > 0) focus(i - 1, ORDER[ORDER.length - 1]);
  };
  const onCellKey = (e: KeyboardEvent<HTMLInputElement>, i: number, cell: Cell) => {
    if (e.key !== 'Enter' || isComposing(e) || e.ctrlKey || e.metaKey || e.altKey) return;
    e.preventDefault();
    move(i, cell, e.shiftKey);
  };
  const side = (i: number, which: 'debit' | 'credit', v: string) => { // one side only: typing an amount clears the other
    const text = cleanDecimal(v, 2), other = which === 'debit' ? 'credit' : 'debit';
    patch(i, { [which]: text, ...(zero(text) ? {} : { [other]: '' }) });
  };
  const money = (l: DocLine, i: number, which: 'debit' | 'credit') => (
    <label className="grid gap-1">
      <span aria-hidden className="text-small text-muted-foreground md:hidden">{t(which === 'debit' ? 'colDebit' : 'colCredit')}</span>
      <Input type="text" inputMode="decimal" autoComplete="off" aria-label={t(which, { n: i + 1 })} data-cell={`${i}:${which}`} className="text-right tabular-nums"
        value={zero(l[which]) ? '' : l[which]} placeholder="0.00"
        onChange={(e) => side(i, which, e.target.value)}
        onBlur={() => { if (!zero(l[which]) && moneyText(l[which] ?? '') !== l[which]) patch(i, { [which]: moneyText(l[which] ?? '') }); }}
        onFocus={(e) => e.target.select()} onKeyDown={(e) => onCellKey(e, i, which)} />
    </label>
  );
  const diffZero = balance?.diff === '0.00';
  return (
    <div ref={root} className="grid gap-3">
      <div aria-hidden className={`hidden gap-2 px-0 text-small font-medium text-muted-foreground md:grid ${COLS}`}>
        <span>{t('colAccount')}</span><span>{t('colDescription')}</span><span className="text-right">{t('colDebit')}</span><span className="text-right">{t('colCredit')}</span><span />
      </div>
      {lines.map((l, i) => (
        <div key={l.id} className={`grid grid-cols-2 items-start gap-2 rounded-lg border border-border p-3 md:border-0 md:p-0 ${COLS}`}>
          <div className="col-span-2 grid gap-1 md:col-span-1" data-row={i}>
            <span aria-hidden className="text-small text-muted-foreground md:hidden">{t('colAccount')}</span>
            <AccountCell cell={`${i}:account`} line={l} accounts={accounts} nameOf={nameOf} label={t('account', { n: i + 1 })}
              onClear={() => patch(i, { accountCode: '' })}
              onPick={(a, next) => { if (next) focusReq.current = { row: i, cell: 'description' }; patch(i, { accountCode: a.code }); }}
              onKey={(e) => onCellKey(e, i, 'account')} onAdvance={(back) => move(i, 'account', back)} />
          </div>
          <div className="col-span-2 grid gap-1 md:col-span-1">
            <span aria-hidden className="text-small text-muted-foreground md:hidden">{t('colDescription')}</span>
            <Input type="text" autoComplete="off" aria-label={t('description', { n: i + 1 })} data-cell={`${i}:description`} value={l.description}
              onChange={(e) => patch(i, { description: e.target.value })} onKeyDown={(e) => onCellKey(e, i, 'description')} />
          </div>
          {money(l, i, 'debit')}
          {money(l, i, 'credit')}
          <Button type="button" variant="ghost" size="icon" aria-label={t('remove', { n: i + 1 })} disabled={lines.length <= 2}
            className="justify-self-end md:justify-self-auto" onClick={() => onChange(lines.filter((_, k) => k !== i))}>
            <Trash2Icon aria-hidden />
          </Button>
        </div>
      ))}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button type="button" variant="outline" onClick={addRow}><PlusIcon aria-hidden data-icon="inline-start" />{t('add')}</Button>
        <p className="text-small text-muted-foreground">{t('hint')}</p>
      </div>
      <section aria-label={t('balance')} aria-busy={computing} className="grid gap-1 rounded-lg bg-muted/40 p-3 text-body md:max-w-md md:w-full md:justify-self-end">
        <dl className="grid gap-1">
        <div className="flex justify-between gap-4"><dt className="text-muted-foreground">{t('totalDebit')}</dt><dd className="tabular-nums" data-testid="jv-debit">{balance ? formatMoney(balance.debit) : computing ? '…' : ''}</dd></div>
        <div className="flex justify-between gap-4"><dt className="text-muted-foreground">{t('totalCredit')}</dt><dd className="tabular-nums" data-testid="jv-credit">{balance ? formatMoney(balance.credit) : computing ? '…' : ''}</dd></div>
        <div className="mt-1 flex justify-between gap-4 border-t border-foreground pt-2 font-semibold"><dt>{t('diff')}</dt><dd className="tabular-nums" data-testid="jv-diff">{balance ? formatMoney(balance.diff) : computing ? '…' : ''}</dd></div>
        </dl>
        <p role="status" className={`text-small ${balance && !diffZero ? 'text-destructive' : 'text-muted-foreground'}`}>{computing ? t('computing') : balance ? (diffZero ? t('balanced') : t('unbalanced', { diff: formatMoney(balance.diff) })) : ''}</p>
      </section>
    </div>
  );
}
