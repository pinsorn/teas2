'use client';
import { useTranslations } from 'next-intl';
import { useEffect, useId, useRef, useState, type ClipboardEvent, type KeyboardEvent, type ReactNode } from 'react';
import { Input } from '@/components/ui/input';
import type { ItemSummary } from '@/domain/types';
import { formatMoney } from '@/lib/format';
import { cn } from '@/lib/utils';
import { isComposing } from './useLineGridKeys';

const DEBOUNCE_MS = 150;

/**
 * Shared type-ahead behind PartyField and ItemField: debounced search, arrow keys, Enter accepts the highlighted match.
 * Enter pressed before the results arrive waits for them (typing fast then Enter must still pick the first match);
 * no match keeps the typed text; Enter while composing (Thai IME) does nothing.
 */
export function useSuggest<T>(search: (q: string) => Promise<T[]>, onPick: (item: T) => void) {
  const listId = useId();
  const [items, setItems] = useState<T[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [failed, setFailed] = useState(false);
  const seq = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const busy = useRef(false);
  const enterWaiting = useRef(false);
  const blurred = useRef(false);
  const cb = useRef({ search, onPick });
  useEffect(() => { cb.current = { search, onPick }; });
  useEffect(() => () => clearTimeout(timer.current), []);

  const cancel = () => { clearTimeout(timer.current); seq.current++; busy.current = false; enterWaiting.current = false; };
  const close = () => { cancel(); setOpen(false); };
  /** Leaving the box hides the list but keeps a pending Enter alive: the user already asked for the first match. */
  const blur = () => { blurred.current = true; setOpen(false); };
  const choose = (item: T) => { close(); cb.current.onPick(item); };

  const query = (q: string) => {
    cancel();
    if (!q.trim()) { setOpen(false); return; }
    const id = ++seq.current;
    blurred.current = false;
    busy.current = true;
    timer.current = setTimeout(async () => {
      let r: T[] = [];
      let bad = false;
      try { r = await cb.current.search(q); } catch { bad = true; }
      if (id !== seq.current) return;
      busy.current = false;
      setItems(r); setActive(0); setFailed(bad);
      if (enterWaiting.current) {
        enterWaiting.current = false;
        if (r[0]) { choose(r[0]); return; }
      }
      setOpen(!blurred.current);
    }, DEBOUNCE_MS);
  };

  /** True when the key was consumed here (the caller must not act on it). */
  const onKeyDown = (e: KeyboardEvent): boolean => {
    if (e.key === 'Enter') {
      if (isComposing(e)) return true;
      if (e.ctrlKey || e.metaKey) return false;
      if (busy.current) { e.preventDefault(); enterWaiting.current = true; return true; }
      if (open && items[active]) { e.preventDefault(); choose(items[active]); return true; }
      return false;
    }
    if (isComposing(e)) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!open || !items.length) return false;
      e.preventDefault();
      setActive((a) => (a + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length);
      return true;
    }
    if (e.key === 'Escape' && open) { e.preventDefault(); e.stopPropagation(); close(); return true; }
    return false;
  };

  return {
    items, open, active, failed, listId, optionId: (i: number) => `${listId}-${i}`,
    query, blur, choose, setActive, onKeyDown,
  };
}
export type Suggest<T> = ReturnType<typeof useSuggest<T>>;

/** The list under the input. Options are picked on mouse-down so the input never loses focus. */
export function SuggestList<T>({ s, label, render }: { s: Suggest<T>; label: string; render: (item: T) => ReactNode }) {
  const t = useTranslations('docEditor');
  if (!s.open) return null;
  return (
    <div className="absolute inset-x-0 top-full z-30 mt-1 rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10">
      {s.items.length > 0 ? (
        <ul id={s.listId} role="listbox" aria-label={label} className="max-h-64 overflow-y-auto">
          {s.items.map((item, i) => (
            <li key={s.optionId(i)} id={s.optionId(i)} role="option" aria-selected={i === s.active}
              onMouseDown={(e) => { e.preventDefault(); s.choose(item); }} onMouseEnter={() => s.setActive(i)}
              className={cn('cursor-default rounded-md px-2.5 py-2 text-body', i === s.active && 'bg-muted')}>
              {render(item)}
            </li>
          ))}
        </ul>
      ) : (
        <p role="status" className={cn('px-2.5 py-2 text-small', s.failed ? 'text-destructive' : 'text-muted-foreground')}>
          {s.failed ? t('searchFailed') : t('noMatch')}
        </p>
      )}
    </div>
  );
}

export interface ItemFieldProps {
  value: string;
  label: string;
  cell: string; // data-cell hook so LineGrid can move focus
  search: (q: string) => Promise<ItemSummary[]>;
  onText: (text: string) => void;
  onPick: (item: ItemSummary) => void;
  /** Keys the suggest list did not consume (Enter = next cell). */
  onKey: (e: KeyboardEvent<HTMLInputElement>) => void;
  onPaste: (e: ClipboardEvent<HTMLInputElement>) => void;
}

/** Description cell with an item type-ahead. Stays a plain text box: free text is always allowed. */
export function ItemField({ value, label, cell, search, onText, onPick, onKey, onPaste }: ItemFieldProps) {
  const s = useSuggest(search, onPick);
  return (
    <div className="relative">
      <Input type="text" autoComplete="off" aria-label={label} data-cell={cell} value={value}
        aria-controls={s.open ? s.listId : undefined} aria-activedescendant={s.open && s.items.length ? s.optionId(s.active) : undefined}
        onChange={(e) => { onText(e.target.value); s.query(e.target.value); }}
        onKeyDown={(e) => { if (!s.onKeyDown(e)) onKey(e); }}
        onBlur={s.blur} onPaste={onPaste} />
      <SuggestList s={s} label={label} render={(it) => (
        <span className="flex items-baseline justify-between gap-3">
          <span>{it.name}</span>
          <span className="shrink-0 text-small text-muted-foreground tabular-nums">{it.code} · {formatMoney(it.unitPrice)}</span>
        </span>
      )} />
    </div>
  );
}
