'use client';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { PartySummary } from '@/domain/types';
import { SuggestList, useSuggest } from './ItemField';

export interface PartyFieldProps {
  kind: 'customer' | 'vendor' | 'employee';
  value?: PartySummary;
  search: (q: string) => Promise<PartySummary[]>;
  onPick: (p: PartySummary) => void;
  /** The user edited the text after picking, so the picked party no longer matches the box. */
  onClear: () => void;
}

export function PartyField({ kind, value, search, onPick, onClear }: PartyFieldProps) {
  const t = useTranslations('docEditor');
  const label = t(`party.${kind}`);
  const [text, setText] = useState(value?.name ?? '');
  const s = useSuggest(search, (p) => { setText(p.name); onPick(p); });
  const id = `${s.listId}-input`;
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <div className="relative">
        <Input id={id} type="text" role="combobox" autoComplete="off" aria-autocomplete="list" aria-expanded={s.expanded}
          aria-controls={s.expanded ? s.listId : undefined} aria-activedescendant={s.expanded ? s.optionId(s.active) : undefined}
          aria-describedby={`${id}-hint`} value={text} data-field="party"
          onChange={(e) => { setText(e.target.value); if (value && e.target.value !== value.name) onClear(); s.query(e.target.value); }}
          onKeyDown={(e) => { s.onKeyDown(e); }} onBlur={s.blur} />
        <SuggestList s={s} label={label} render={(p) => (
          <span className="flex items-baseline justify-between gap-3">
            <span>{p.name}</span><span className="shrink-0 text-small text-muted-foreground tabular-nums">{p.code}</span>
          </span>
        )} />
      </div>
      <p id={`${id}-hint`} className="text-small text-muted-foreground">{t('partyHint')}</p>
      {value && (
        <div className="rounded-lg bg-muted px-3 py-2 text-small">
          <p className="tabular-nums">{value.taxId ? t('taxIdLine', { tin: value.taxId, branch: value.branchCode ?? '-' }) : t('noTaxId')}</p>
          {value.address && <p className="text-muted-foreground">{value.address}</p>}
        </div>
      )}
    </div>
  );
}
