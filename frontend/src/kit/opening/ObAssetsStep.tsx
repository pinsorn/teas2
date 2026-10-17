'use client';
import { PlusIcon, Trash2Icon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { ObAsset } from '@/domain/types';
import { Cell, MoneyField, selectCls } from './fields';

export const ASSET_CLASSES = ['equipment', 'vehicle'] as const;
const blank = (): ObAsset => ({ name: '', assetClass: 'equipment', cost: '', accumulated: '0.00', acquired: '', lifeMonths: 60 });

/** Step 4: the fixed assets with their cost and accumulated depreciation to the cut-off. They are stored for the asset register (AC5); their totals tie to the asset and accumulated-depreciation lines of the trial balance. */
export function ObAssetsStep({ value, onChange }: { value: ObAsset[]; onChange: (v: ObAsset[]) => void }) {
  const t = useTranslations('opening.assets');
  const patch = (i: number, p: Partial<ObAsset>) => onChange(value.map((x, k) => (k === i ? { ...x, ...p } : x)));
  return (
    <div className="grid gap-3">
      <p className="text-body text-muted-foreground">{t('hint')}</p>
      {value.map((x, i) => (
        <div key={i} className="grid grid-cols-2 items-end gap-2 rounded-lg border border-border p-3 md:grid-cols-[minmax(0,1.5fr)_10rem_9rem_9rem_9rem_6rem_var(--ctl-h)]">
          <Cell label={t('name')} className="col-span-2 md:col-span-1"><Input aria-label={t('nameN', { n: i + 1 })} value={x.name} onChange={(e) => patch(i, { name: e.target.value })} /></Cell>
          <Cell label={t('class')}>
            <select aria-label={t('classN', { n: i + 1 })} className={selectCls} value={x.assetClass} onChange={(e) => patch(i, { assetClass: e.target.value })}>
              {ASSET_CLASSES.map((c) => <option key={c} value={c}>{t(`classes.${c}`)}</option>)}
            </select>
          </Cell>
          <Cell label={t('acquired')}><Input type="date" aria-label={t('acquiredN', { n: i + 1 })} value={x.acquired} onChange={(e) => patch(i, { acquired: e.target.value })} /></Cell>
          <Cell label={t('cost')}><MoneyField label={t('costN', { n: i + 1 })} value={x.cost} onChange={(v) => patch(i, { cost: v })} /></Cell>
          <Cell label={t('accumulated')}><MoneyField label={t('accumulatedN', { n: i + 1 })} value={x.accumulated} onChange={(v) => patch(i, { accumulated: v })} /></Cell>
          <Cell label={t('life')}><Input type="number" min={1} aria-label={t('lifeN', { n: i + 1 })} value={x.lifeMonths} onChange={(e) => patch(i, { lifeMonths: Number(e.target.value) || 0 })} /></Cell>
          <Button type="button" variant="ghost" size="icon" aria-label={t('remove', { n: i + 1 })} className="justify-self-end" onClick={() => onChange(value.filter((_, k) => k !== i))}><Trash2Icon aria-hidden /></Button>
        </div>
      ))}
      <div><Button type="button" variant="outline" onClick={() => onChange([...value, blank()])}><PlusIcon aria-hidden data-icon="inline-start" />{t('add')}</Button></div>
    </div>
  );
}
