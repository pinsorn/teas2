'use client';
import { useLocale, useTranslations } from 'next-intl';
import { PERMISSIONS } from '@/domain/permissions';

const ORDER = Object.keys(PERMISSIONS);
/** Every catalogue code exactly once, grouped by area (documents by type), in catalogue order. */
export function groupsOf(codes: string[] = ORDER): { key: string; codes: string[] }[] {
  const out = new Map<string, string[]>();
  for (const c of codes) {
    const [area, type] = c.split('.');
    const key = area === 'doc' ? `doc.${type}` : area;
    out.set(key, [...(out.get(key) ?? []), c]);
  }
  return [...out].map(([key, list]) => ({ key, codes: list }));
}

/** Rows = the catalogue permissions (Thai labels from `domain/permissions.ts`); the column is "granted". `readOnly` for a system role. */
export function PermissionMatrix({ value, onChange, readOnly, label }: { value: string[]; onChange?: (next: string[]) => void; readOnly?: boolean; label: string }) {
  const t = useTranslations('settings.matrix');
  const td = useTranslations('docTypes');
  const locale = useLocale() === 'en' ? 'en' : 'th';
  const granted = new Set(value);
  const toggle = (codes: string[], on: boolean) => onChange?.([...new Set(on ? [...value, ...codes] : value.filter((c) => !codes.includes(c)))].sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b)));
  return (
    <div role="group" aria-label={label} className="grid gap-3" data-testid="permission-matrix">
      {groupsOf().map((g) => {
        const all = g.codes.every((c) => granted.has(c));
        const name = g.key.startsWith('doc.') ? td(`${g.key.slice(4)}.title` as never) : t(`area.${g.key}` as never);
        return (
          <fieldset key={g.key} className="rounded-lg border p-3">
            <legend className="flex items-center gap-3 px-1 font-semibold">
              {name}
              {readOnly ? null : (
                <label className="flex items-center gap-1 text-small font-normal text-muted-foreground">
                  <input type="checkbox" className="size-4 accent-(--color-brand)" checked={all} onChange={(e) => toggle(g.codes, e.target.checked)} aria-label={t('selectAll', { name })} />{t('all')}
                </label>
              )}
            </legend>
            <ul className="grid gap-1 sm:grid-cols-2">
              {g.codes.map((c) => (
                <li key={c}>
                  <label className="flex items-start gap-2 py-0.5 text-body">
                    <input type="checkbox" data-code={c} className="mt-1 size-4 accent-(--color-brand)" checked={granted.has(c)} disabled={readOnly} onChange={(e) => toggle([c], e.target.checked)} />
                    <span>{PERMISSIONS[c][locale]} <span className="text-small text-muted-foreground">{c}</span></span>
                  </label>
                </li>
              ))}
            </ul>
          </fieldset>
        );
      })}
    </div>
  );
}
