import { useQuery } from '@tanstack/react-query';
import { useId } from 'react';
import { useTranslations } from 'next-intl';
import { useMe } from '@/app-shell/useMe';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { ReportParamSpec } from '@/domain/reports';
import { endpoints } from '@/lib/api/endpoints';

const INPUT_TYPE = { date: 'date', month: 'month', year: 'number' } as const;
const SELECT = 'h-9 rounded-md border border-input bg-background px-2 text-body';

/** A party parameter is chosen from the company's parties and carries the party's ID (a name is not an identity). The id in the URL stays an option even when the list does not hold it (a deactivated party). */
function PartySelect({ id, value, kind, required, onChange }: { id: string; value: string; kind?: 'customer' | 'vendor'; required?: boolean; onChange: (v: string) => void }) {
  const t = useTranslations();
  const { me } = useMe();
  const companyId = me?.activeCompanyId ?? '';
  const q = useQuery({ queryKey: [companyId, 'report-parties', kind ?? 'all'], enabled: !!companyId, queryFn: () => endpoints.searchParties({ ...(kind ? { kind } : {}), limit: 200 }) });
  const items = q.data?.items ?? [];
  return (
    <select id={id} value={value} required={required} onChange={(e) => onChange(e.target.value)} className={SELECT}>
      <option value="">{t('reports.pickParty')}</option>
      {value && !items.some((p) => p.id === value) ? <option value={value}>{value}</option> : null}
      {items.map((p) => <option key={p.id} value={p.id}>{p.code} {p.name}</option>)}
    </select>
  );
}

/** One labelled control per parameter spec. `values` are strings (a bool is "true" or ""); the parent owns debounce and the URL. */
export function ReportParams({ specs, values, onChange }: { specs: ReportParamSpec[]; values: Record<string, string>; onChange: (key: string, value: string) => void }) {
  const t = useTranslations();
  const id = useId();
  return (
    <div role="group" aria-label={t('reports.paramsLabel')} className="flex flex-wrap items-end gap-4 print:hidden">
      {specs.filter((s) => !s.hidden).map((s) => {
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
            {s.kind === 'party' ? (
              <PartySelect id={fid} value={v} kind={s.partyKind} required={s.required} onChange={(x) => onChange(s.key, x)} />
            ) : s.kind === 'select' ? (
              <select id={fid} value={v} required={s.required} onChange={(e) => onChange(s.key, e.target.value)} className={SELECT}>
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
