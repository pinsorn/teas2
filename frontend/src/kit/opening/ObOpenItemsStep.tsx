'use client';
import { PlusIcon, Trash2Icon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { ObOpenItem, ObSide } from '@/domain/types';
import { Cell, MoneyField, PartySelect, selectCls } from './fields';

export const SIDES: ObSide[] = ['AR', 'AP', 'EMP', 'DEP', 'PRE'];
const PARTY_KIND = { AR: 'customer', AP: 'vendor', EMP: 'employee', DEP: 'customer', PRE: 'vendor' } as const;
const blank = (): ObOpenItem => ({ side: 'AR', partyId: '', docNumber: '', docDate: '', amount: '' });

/** Step 3: the open items, one row per old document. They are frozen at their amounts when issued and settle through the normal receipt / payment voucher; the totals tie to the trial-balance line of their account (checked by the server). */
export function ObOpenItemsStep({ value, onChange }: { value: ObOpenItem[]; onChange: (v: ObOpenItem[]) => void }) {
  const t = useTranslations('opening.items');
  const patch = (i: number, p: Partial<ObOpenItem>) => onChange(value.map((x, k) => (k === i ? { ...x, ...p } : x)));
  return (
    <div className="grid gap-3">
      <p className="text-body text-muted-foreground">{t('hint')}</p>
      <div aria-hidden className="hidden gap-2 text-small font-medium text-muted-foreground md:grid md:grid-cols-[12rem_minmax(0,1.2fr)_minmax(0,1fr)_9rem_9rem_9rem_var(--ctl-h)]">
        <span>{t('side')}</span><span>{t('party')}</span><span>{t('docNumber')}</span><span>{t('docDate')}</span><span>{t('dueDate')}</span><span className="text-right">{t('amount')}</span><span />
      </div>
      {value.map((x, i) => (
        <div key={i} className="grid grid-cols-2 items-end gap-2 rounded-lg border border-border p-3 md:grid-cols-[12rem_minmax(0,1.2fr)_minmax(0,1fr)_9rem_9rem_9rem_var(--ctl-h)] md:border-0 md:p-0">
          <Cell label={t('side')}>
            <select aria-label={t('sideN', { n: i + 1 })} className={selectCls} value={x.side} onChange={(e) => patch(i, { side: e.target.value as ObSide, partyId: '' })}>
              {SIDES.map((s) => <option key={s} value={s}>{t(`sides.${s}`)}</option>)}
            </select>
          </Cell>
          <Cell label={t('party')}><PartySelect kind={PARTY_KIND[x.side]} label={t('partyN', { n: i + 1 })} value={x.partyId} onChange={(id) => patch(i, { partyId: id })} /></Cell>
          <Cell label={t('docNumber')}><Input aria-label={t('docNumberN', { n: i + 1 })} value={x.docNumber} onChange={(e) => patch(i, { docNumber: e.target.value })} /></Cell>
          <Cell label={t('docDate')}><Input type="date" aria-label={t('docDateN', { n: i + 1 })} value={x.docDate} onChange={(e) => patch(i, { docDate: e.target.value })} /></Cell>
          <Cell label={t('dueDate')}><Input type="date" aria-label={t('dueDateN', { n: i + 1 })} value={x.dueDate ?? ''} onChange={(e) => patch(i, { dueDate: e.target.value || undefined })} /></Cell>
          <Cell label={t('amount')}><MoneyField label={t('amountN', { n: i + 1 })} value={x.amount} onChange={(v) => patch(i, { amount: v })} /></Cell>
          <Button type="button" variant="ghost" size="icon" aria-label={t('remove', { n: i + 1 })} className="justify-self-end md:justify-self-auto" onClick={() => onChange(value.filter((_, k) => k !== i))}><Trash2Icon aria-hidden /></Button>
        </div>
      ))}
      <div><Button type="button" variant="outline" onClick={() => onChange([...value, blank()])}><PlusIcon aria-hidden data-icon="inline-start" />{t('add')}</Button></div>
    </div>
  );
}
