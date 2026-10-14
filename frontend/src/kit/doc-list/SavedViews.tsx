'use client';
import { XIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

export interface SavedView { key: string; label: string; params: Record<string, string> }

const storeKey = (type: string) => `teas2.views.${type}`;
export function loadUserViews(type: string): SavedView[] {
  try {
    const v = JSON.parse(localStorage.getItem(storeKey(type)) ?? '[]');
    return Array.isArray(v) ? v.filter((x) => x && typeof x.key === 'string' && typeof x.label === 'string' && x.params) : [];
  } catch { return []; }
}
function saveUserViews(type: string, views: SavedView[]) {
  try { localStorage.setItem(storeKey(type), JSON.stringify(views)); } catch { /* private mode: views last for this session only */ }
}

/** Descriptor presets plus the user's own views (localStorage). Selecting one sets the URL filters; "all" clears them. */
export function SavedViews({ type, presets, activeKey, current, onSelect }: {
  type: string; presets: SavedView[]; activeKey?: string; current: Record<string, string>;
  onSelect: (v: SavedView | null) => void;
}) {
  const t = useTranslations('docList');
  const [mine, setMine] = useState<SavedView[]>(() => loadUserViews(type));
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const update = (next: SavedView[]) => { setMine(next); saveUserViews(type, next); };
  const save = () => {
    const label = name.trim();
    if (!label) return;
    update([...mine, { key: `u-${Date.now()}`, label, params: current }]);
    setName(''); setNaming(false);
  };
  const chip = (v: SavedView | null, label: string, key: string, removable = false) => (
    <li key={key} className="flex items-center">
      <Button size="sm" variant={(v?.key ?? '') === (activeKey ?? '') ? 'default' : 'outline'} onClick={() => onSelect(v)}
        aria-pressed={(v?.key ?? '') === (activeKey ?? '')} className={cn(removable && 'rounded-r-none')}>{label}</Button>
      {removable && v ? (
        <Button size="icon-sm" variant="outline" className="rounded-l-none border-l-0" aria-label={t('removeView', { name: label })}
          onClick={() => update(mine.filter((m) => m.key !== v.key))}><XIcon aria-hidden /></Button>
      ) : null}
    </li>
  );
  return (
    <nav aria-label={t('viewsLabel')} className="flex flex-wrap items-center gap-2">
      <ul className="flex flex-wrap items-center gap-2">
        {chip(null, t('viewAll'), 'all')}
        {presets.map((v) => chip(v, v.label, v.key))}
        {mine.map((v) => chip(v, v.label, v.key, true))}
      </ul>
      {naming ? (
        <form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); save(); }}>
          <Input autoFocus aria-label={t('viewName')} value={name} onChange={(e) => setName(e.target.value)} className="w-40" />
          <Button size="sm" type="submit">{t('saveViewConfirm')}</Button>
        </form>
      ) : (
        <Button size="sm" variant="ghost" onClick={() => setNaming(true)}>{t('saveView')}</Button>
      )}
    </nav>
  );
}
