import { useQuery } from '@tanstack/react-query';
import { useId } from 'react';
import { useTranslations } from 'next-intl';
import { useMe } from '@/app-shell/useMe';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { ReportParamSpec } from '@/domain/reports';
import type { PartySummary } from '@/domain/types';
import { PartyField } from '@/kit/doc-editor/PartyField';
import { endpoints } from '@/lib/api/endpoints';

const INPUT_TYPE = { date: 'date', month: 'month', year: 'number' } as const;
const SELECT = 'h-9 rounded-md border border-input bg-background px-2 text-body';

/** A party parameter is found by typing (the type-ahead of the document editor, no quick-create) and carries the party's ID (a name is not an identity). The id already in the URL shows the party's NAME: it is fetched by id (the master record), never looked up in a page of the list,
 *  so a party beyond the first 200 shows its name too; a party the record store does not hold (another company's, deleted) shows its id. */
function PartyPick({ value, kind, onChange }: { value: string; kind: 'customer' | 'vendor'; onChange: (v: string) => void }) {
  const { me } = useMe();
  const companyId = me?.activeCompanyId ?? '';
  const known = useQuery({ queryKey: [companyId, 'report-party', kind, value], enabled: !!companyId && !!value, retry: false, queryFn: () => endpoints.getRecord(kind, value) });
  if (value && known.isLoading) return null; // the name of the id in the URL is on its way: the box is filled once, when it appears
  const shown = value ? ({ id: value, kind, code: String(known.data?.code ?? ''), name: String(known.data?.name ?? value), vatRegistered: false, paymentTermDays: 0, entityKind: 'juristic' } as PartySummary) : undefined;
  return <PartyField kind={kind} value={shown} search={(q) => endpoints.searchParties({ kind, q, limit: 20 }).then((p) => p.items)} onPick={(p) => onChange(p.id)} onClear={() => onChange('')} />;
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
            {s.kind === 'party' ? null : <Label htmlFor={fid}>{t(s.labelKey as never)}{s.required ? <span aria-hidden> *</span> : null}</Label>}
            {s.kind === 'party' ? (
              <PartyPick value={v} kind={s.partyKind ?? 'customer'} onChange={(x) => onChange(s.key, x)} />
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
