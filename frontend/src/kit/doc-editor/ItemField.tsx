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
 * no match keeps the typed text and (T11) still performs the Enter the user pressed, via `onEnterNoMatch`; Enter while composing (Thai IME) does nothing.
 */
export function useSuggest<T>(search: (q: string) => Promise<T[]>, onPick: (item: T) => void, onEnterNoMatch?: (back: boolean) => void) {
  const listId = useId();
  const [items, setItems] = useState<T[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [failed, setFailed] = useState(false);
  const [note, setNote] = useState<'searching' | 'done'>();
  const seq = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const busy = useRef(false);
  const enterWaiting = useRef(false);
  const enterBack = useRef(false);
  const blurred = useRef(false);
  const cb = useRef({ search, onPick, onEnterNoMatch });
  useEffect(() => { cb.current = { search, onPick, onEnterNoMatch }; });
  useEffect(() => () => clearTimeout(timer.current), []);

  const cancel = () => { clearTimeout(timer.current); seq.current++; busy.current = false; enterWaiting.current = false; setNote(undefined); };
  const close = () => { cancel(); setOpen(false); };
  /** Leaving the box hides the list and drops a pending Enter (as any text change does): an Enter queued before the user moved on must not act later, e.g. open a form. */
  const blur = () => { blurred.current = true; enterWaiting.current = false; setOpen(false); };
  const choose = (item: T) => { close(); cb.current.onPick(item); };

  const query = (q: string) => {
    cancel();
    if (!q.trim()) { setOpen(false); return; }
    const id = ++seq.current;
    blurred.current = false;
    busy.current = true;
    setNote('searching');
    timer.current = setTimeout(async () => {
      let r: T[] = [];
      let bad = false;
      try { r = await cb.current.search(q); } catch { bad = true; }
      if (id !== seq.current) return;
      busy.current = false;
      setItems(r); setActive(0); setFailed(bad); setNote('done');
      if (enterWaiting.current) {
        enterWaiting.current = false;
        if (r[0]) { choose(r[0]); return; }
        if (!blurred.current) cb.current.onEnterNoMatch?.(enterBack.current);
      }
      setOpen(!blurred.current);
    }, DEBOUNCE_MS);
  };

  /** True when the key was consumed here (the caller must not act on it). */
  const onKeyDown = (e: KeyboardEvent): boolean => {
    if (e.key === 'Enter') {
      if (isComposing(e)) return true;
      if (e.ctrlKey || e.metaKey) return false;
      if (busy.current) { e.preventDefault(); enterWaiting.current = true; enterBack.current = e.shiftKey; return true; }
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
    items, open, active, failed, note, expanded: open && items.length > 0, listId, optionId: (i: number) => `${listId}-${i}`,
    query, blur, choose, setActive, onKeyDown,
  };
}
export type Suggest<T> = ReturnType<typeof useSuggest<T>>;

/** The list under the input, plus a polite live region: searching / N results / no results / failed. */
export function SuggestList<T>({ s, label, render, announce, noMatch }: { s: Suggest<T>; label: string; render: (item: T) => ReactNode; /** Live-region text for a result set that is not a plain "N results" (e.g. only an add option); undefined = the default. */ announce?: (items: T[]) => string | undefined; /** Replaces the "no match" text (e.g. to say what the user lacks to add one). */ noMatch?: string }) {
  const t = useTranslations('docEditor');
  const none = noMatch ?? t('noMatch');
  const say = s.note === 'searching' ? t('searching') : s.note === 'done'
    ? (s.failed ? t('searchFailed') : s.items.length ? (announce ? announce(s.items) ?? t('results', { count: s.items.length }) : t('results', { count: s.items.length })) : none) : '';
  return (
    <>
      <span role="status" className="sr-only">{say}</span>
      {s.open && (
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
            <p aria-hidden className={cn('px-2.5 py-2 text-small', s.failed ? 'text-destructive' : 'text-muted-foreground')}>
              {s.failed ? t('searchFailed') : none}
            </p>
          )}
        </div>
      )}
    </>
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
  /** An Enter that waited for results which turned out empty: do what Enter does on a plain cell (move on). */
  onAdvance?: (back: boolean) => void;
}

/** Description cell: an editable combobox over the item list. Free text is always allowed. */
export function ItemField({ value, label, cell, search, onText, onPick, onKey, onPaste, onAdvance }: ItemFieldProps) {
  const s = useSuggest(search, onPick, onAdvance);
  return (
    <div className="relative">
      <Input type="text" role="combobox" autoComplete="off" aria-autocomplete="list" aria-label={label} data-cell={cell} value={value}
        aria-expanded={s.expanded} aria-controls={s.expanded ? s.listId : undefined} aria-activedescendant={s.expanded ? s.optionId(s.active) : undefined}
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
