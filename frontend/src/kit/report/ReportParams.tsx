import { useId } from 'react';
import { useTranslations } from 'next-intl';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { ReportParamSpec } from '@/domain/reports';

const INPUT_TYPE = { date: 'date', month: 'month', year: 'number' } as const;

/** One labelled control per parameter spec. `values` are strings (a bool is "true" or ""); the parent owns debounce and the URL. */
export function ReportParams({ specs, values, onChange }: { specs: ReportParamSpec[]; values: Record<string, string>; onChange: (key: string, value: string) => void }) {
  const t = useTranslations();
  const id = useId();
  return (
    <div role="group" aria-label={t('reports.paramsLabel')} className="flex flex-wrap items-end gap-4 print:hidden">
      {specs.map((s) => {
        const fid = `${id}-${s.key}`;
        const v = values[s.key] ?? '';
        if (s.kind === 'bool') {
          return (
            <div key={s.key} className="flex h-9 items-center gap-2">
              <Checkbox id={fid} checked={v === 'true'} onCheckedChange={(c) => onChange(s.key, c === true ? 'true' : '')} />
              <Label htmlFor={fid}>{t(s.labelKey as never)}</Label>
            </div>
          );
        }
        return (
          <div key={s.key} className="grid gap-1.5">
            <Label htmlFor={fid}>{t(s.labelKey as never)}{s.required ? <span aria-hidden> *</span> : null}</Label>
            {s.kind === 'select' ? (
              <select id={fid} value={v} required={s.required} onChange={(e) => onChange(s.key, e.target.value)}
                className="h-9 rounded-md border border-input bg-background px-2 text-body">
                {s.required ? null : <option value="" />}
                {s.options?.map((o) => <option key={o.value} value={o.value}>{t(o.labelKey as never)}</option>)}
              </select>
            ) : (
              <Input id={fid} type={INPUT_TYPE[s.kind as keyof typeof INPUT_TYPE] ?? 'text'} value={v} required={s.required} onChange={(e) => onChange(s.key, e.target.value)} />
            )}
          </div>
        );
      })}
    </div>
  );
}
