'use client';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { PartySummary } from '@/domain/types';
import { SuggestList, useSuggest } from './ItemField';
import { QuickCreateParty } from './QuickCreateParty';

export interface PartyFieldProps {
  kind: 'customer' | 'vendor' | 'employee';
  value?: PartySummary;
  search: (q: string) => Promise<PartySummary[]>;
  onPick: (p: PartySummary) => void;
  /** The user edited the text after picking, so the picked party no longer matches the box. */
  onClear: () => void;
  /** True while a lookup is running: the host must not act on the document until the pick has landed. */
  onPending?: (pending: boolean) => void;
  /**
   * Customer / vendor editors: may the user add a party that is not in the list? true = the last option offers it (and opens the form),
   * false = it does not and the "no match" hint names the permission, unset = no quick-create at all.
   */
  canCreate?: boolean;
}

/** A search hit, or the "add this name" option that stands in when nothing matches. */
type Option = PartySummary | { create: string };
const isCreate = (o: Option): o is { create: string } => 'create' in o;

export function PartyField({ kind, value, search, onPick, onClear, onPending, canCreate }: PartyFieldProps) {
  const t = useTranslations('docEditor');
  const label = t(`party.${kind}`);
  const [text, setText] = useState(value?.name ?? '');
  const [creating, setCreating] = useState<string>();
  const quick = kind === 'employee' ? undefined : canCreate;
  const searchOrOffer = async (q: string): Promise<Option[]> => {
    const hits = await search(q);
    return hits.length === 0 && quick && q.trim() ? [{ create: q.trim() }] : hits;
  };
  const s = useSuggest<Option>(searchOrOffer, (o) => { if (isCreate(o)) setCreating(o.create); else { setText(o.name); onPick(o); } });
  const picked = (p: PartySummary) => { setCreating(undefined); setText(p.name); onPick(p); };
  const id = `${s.listId}-input`;
  const searching = s.note === 'searching';
  useEffect(() => { onPending?.(searching); }, [searching, onPending]);
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <div className="relative">
        <Input id={id} type="text" role="combobox" autoComplete="off" aria-autocomplete="list" aria-expanded={s.expanded}
          aria-controls={s.expanded ? s.listId : undefined} aria-activedescendant={s.expanded ? s.optionId(s.active) : undefined}
          aria-describedby={`${id}-hint`} value={text} data-field="party"
          onChange={(e) => { setText(e.target.value); if (e.target.value !== value?.name) onClear(); /* also cancels a pick whose lookup is still pending */ s.query(e.target.value); }}
          onKeyDown={(e) => { s.onKeyDown(e); }} onBlur={s.blur} />
        <SuggestList s={s} label={label} announce={(os) => (os.length === 1 && isCreate(os[0]) ? t('quickCreate', { party: label, name: os[0].create }) : undefined)} noMatch={quick === false ? t('noMatchNeedManage', { permission: 'party.manage', party: label }) : undefined}
          render={(p) => isCreate(p) ? <span>{t('quickCreate', { party: label, name: p.create })}</span> : (
            <span className="flex items-baseline justify-between gap-3">
              <span>{p.name}</span><span className="shrink-0 text-small text-muted-foreground tabular-nums">{p.code}</span>
            </span>
          )} />
      </div>
      <p id={`${id}-hint`} className="text-small text-muted-foreground">{t('partyHint')}</p>
      {creating !== undefined && kind !== 'employee' ? <QuickCreateParty kind={kind} name={creating} onCreated={picked} onClose={() => setCreating(undefined)} /> : null}
      {value && (
        <div className="rounded-lg bg-muted px-3 py-2 text-small">
          <p className="tabular-nums">{value.taxId ? t('taxIdLine', { tin: value.taxId, branch: value.branchCode ?? '-' }) : t('noTaxId')}</p>
          {value.address && <p className="text-muted-foreground">{value.address}</p>}
        </div>
      )}
    </div>
  );
}
