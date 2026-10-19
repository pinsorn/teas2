'use client';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useId, type ReactNode } from 'react';
import type { FieldValues, UseFormReturn } from 'react-hook-form';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useMe } from '@/app-shell/useMe';
import { isValidTin } from '@/domain/tin';
import type { FieldCondition, FieldSpec } from '@/domain/records';
import { endpoints } from '@/lib/api/endpoints';
import { qk } from '@/lib/query/keys';
import { categoryApi } from '@/records/expense-categories';

type Values = Record<string, unknown>;
const select = 'h-(--ctl-h) w-full rounded-lg border border-input bg-card px-3 text-body outline-none aria-invalid:border-2 aria-invalid:border-destructive disabled:bg-muted';

export const isVisible = (f: FieldSpec, v: Values) => !f.showWhen || v[f.showWhen.key] === f.showWhen.equals;
const holds = (c: FieldCondition, v: Values) => v[c.key] === c.equals;
export const isRequired = (f: FieldSpec, v: Values) => !!f.required || !!f.requiredWhen?.some((c) => holds(c, v));
const isEmpty = (x: unknown) => x === undefined || x === null || x === '' || (Array.isArray(x) && x.length === 0);

/** Shape-only validation of the visible fields (required, digits, TIN checksum). Whether a TIN is *really* required, unique, etc. is the server's call. */
export function validateShape(fields: FieldSpec[], v: Values, msg: { required: string; tin: string; branch: string; int: string }): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const f of fields) {
    if (!isVisible(f, v)) continue;
    const x = v[f.key];
    if (f.kind !== 'bool' && isEmpty(x)) {
      if (isRequired(f, v)) errors[f.key] = msg.required;
      else if (f.kind === 'branch' && !isEmpty(v.taxId)) errors[f.key] = msg.branch; // a branch goes with a TIN
      continue;
    }
    if (f.kind === 'tin' && !isValidTin(String(x))) errors[f.key] = msg.tin;
    else if (f.kind === 'branch' && !/^\d{5}$/.test(String(x))) errors[f.key] = msg.branch;
    else if (f.kind === 'int' && !/^\d+$/.test(String(x).trim())) errors[f.key] = msg.int;
  }
  return errors;
}

/** What the form sends: visible fields only, trimmed, empty omitted, numbers as numbers. */
export function payloadOf(fields: FieldSpec[], v: Values): Values {
  const out: Values = {};
  for (const f of fields) {
    if (!isVisible(f, v)) continue;
    const x = v[f.key];
    if (f.kind === 'bool') out[f.key] = x === true;
    else if (isEmpty(x)) continue;
    else if (f.kind === 'int') out[f.key] = Number(String(x).trim());
    else out[f.key] = typeof x === 'string' ? x.trim() : x;
  }
  return out;
}

export function defaultsOf(fields: FieldSpec[], row?: Values): Values {
  return Object.fromEntries(fields.map((f) => {
    const x = row?.[f.key];
    if (f.kind === 'bool') return [f.key, x === undefined ? f.defaultValue === true : x === true];
    if (f.multiple) return [f.key, Array.isArray(x) ? x : []];
    return [f.key, x === undefined || x === null ? (f.defaultValue ?? '') : String(x)];
  }));
}

/** `values` = the form's current values (from useWatch in the parent): drives required marks and the controlled pickers. */
export function Field({ spec, form, values, error, locked }: { spec: FieldSpec; form: UseFormReturn<FieldValues>; values: Values; error?: string; locked?: boolean }) {
  const t = useTranslations();
  const id = useId();
  const { me } = useMe();
  const c = me?.activeCompanyId ?? '';
  const label = t(spec.labelKey);
  const { register, setValue } = form;
  const errId = `${id}-err`, hintId = `${id}-hint`;
  const describedBy = [error ? errId : '', locked ? hintId : ''].filter(Boolean).join(' ') || undefined;
  const common = { id, 'aria-invalid': !!error, 'aria-describedby': describedBy, 'aria-required': isRequired(spec, values) || undefined, readOnly: locked };

  const wht = useQuery({ queryKey: qk.whtTypes(c), queryFn: endpoints.whtTypes, enabled: !!me && spec.optionsFrom === 'wht-types' });
  const items = useQuery({ queryKey: [...qk.itemOptions(c), spec.itemUsage], queryFn: () => endpoints.searchItems({ limit: 200, usage: spec.itemUsage }), enabled: !!me && spec.kind === 'item' });

  // the header accounts a chart account can sit under (every page: a chart can be longer than one)
  const headers = useQuery({ queryKey: [c, 'records', 'account', { headers: true }], enabled: !!me && spec.optionsFrom === 'account-headers', queryFn: async () => {
    const out: { code: string; text: string }[] = [];
    for (let cursor: string | undefined, n = 0; n < 50; n++) {
      const p = await endpoints.listRecords('account', { active: 'true', limit: 100, cursor });
      out.push(...p.items.filter((r) => r.postable === false).map((r) => ({ code: String(r.code), text: `${String(r.code)} · ${String(r.name)}` })));
      cursor = p.nextCursor;
      if (!cursor) break;
    }
    return out;
  } });
  // ST2a: the item form's expense category is the company's editable list (the descriptor's fixed options are only the first paint)
  const cats = useQuery({ queryKey: [c, 'expense-categories'], queryFn: categoryApi.list, enabled: !!me && spec.key === 'expenseCategory' });
  const gl = useQuery({ queryKey: qk.bankGlAccounts(c), queryFn: endpoints.bankGlAccounts, enabled: !!me && spec.kind === 'account' && !locked });

  let control: ReactNode;
  if (spec.kind === 'bool') {
    control = <input type="checkbox" {...register(spec.key)} id={id} aria-invalid={!!error} aria-describedby={describedBy} className="size-4 accent-(--color-brand)" />;
  } else if (spec.kind === 'textarea') {
    control = <Textarea {...register(spec.key)} {...common} />;
  } else if (spec.kind === 'select') {
    const current = String(values[spec.key] ?? '');
    const fixed = spec.options?.map((o) => ({ value: o.value, text: t(o.labelKey) }));
    const remote = spec.optionsFrom === 'wht-types' ? wht.data?.map((w) => ({ value: w.code, text: `${w.code} · ${w.nameTh} (${w.rate})` })) : undefined;
    const hdr = spec.optionsFrom === 'account-headers' ? headers.data?.map((h) => ({ value: h.code, text: h.text })) : undefined;
    const live = spec.key === 'expenseCategory' ? cats.data?.items.filter((x) => x.active || x.code === current).map((x) => ({ value: x.code, text: x.nameTh })) : undefined;
    const opts = live ?? fixed ?? remote ?? hdr ?? [];
    control = (
      <select {...register(spec.key)} id={id} aria-invalid={!!error} aria-describedby={describedBy} aria-required={common['aria-required']} className={select}>
        <option value="">{t('records.common.selectPlaceholder')}</option>
        {opts.map((o) => <option key={o.value} value={o.value}>{o.text}</option>)}
        {current && !opts.some((o) => o.value === current) ? <option value={current}>{current}</option> : null}
      </select>
    );
  } else if (spec.kind === 'account' && !locked) { // a GL account for a bank / cash account: the ones of the chosen type that no other bank account owns (§5.13)
    const current = String(values[spec.key] ?? '');
    const free = (gl.data ?? []).filter((a) => a.subClass === (values.kind === 'cash' ? 'cash' : 'bank') && (!a.taken || a.code === current));
    // one keyed list, the current value always in it: the option the form was opened on must survive the list arriving (a select drops its value when its option is replaced)
    const opts = (free.some((a) => a.code === current) || !current ? free : [...free, { code: current, nameTh: '' }]).sort((x, y) => x.code.localeCompare(y.code));
    control = (
      <select {...register(spec.key)} id={id} aria-invalid={!!error} aria-describedby={describedBy} aria-required={common['aria-required']} className={select}>
        <option value="">{t('bank.glPlaceholder')}</option>
        {opts.map((a) => <option key={a.code} value={a.code}>{a.nameTh ? `${a.code} · ${a.nameTh}` : a.code}</option>)}
      </select>
    );
  } else if (spec.kind === 'item') {
    const picked = (values[spec.key] as string[] | undefined) ?? [];
    control = (
      <ul role="group" aria-labelledby={`${id}-label`} className="max-h-40 overflow-y-auto rounded-lg border bg-card p-2">
        {(items.data?.items ?? []).map((it) => (
          <li key={it.id}>
            <label className="flex items-center gap-2 py-0.5 text-body">
              <input type="checkbox" className="size-4 accent-(--color-brand)" checked={picked.includes(it.id)}
                onChange={(e) => setValue(spec.key, e.target.checked ? [...picked, it.id] : picked.filter((x) => x !== it.id), { shouldDirty: true })} />
              <span>{it.code} · {it.name}</span>
            </label>
          </li>
        ))}
        {items.isError ? <li className="text-small text-muted-foreground">{t('state.errorTitle')}</li> : null}
      </ul>
    );
  } else {
    const numeric = spec.kind === 'tin' || spec.kind === 'branch' || spec.kind === 'int';
    control = <Input {...register(spec.key)} {...common} type={spec.kind === 'date' ? 'date' : 'text'} inputMode={numeric ? 'numeric' : undefined}
      maxLength={spec.kind === 'tin' ? 13 : spec.kind === 'branch' ? 5 : undefined} />;
  }

  // frozen after use: a disabled fieldset blocks the control but (unlike `disabled` on the control itself) leaves its value in the form
  if (locked && (spec.kind === 'bool' || spec.kind === 'select')) control = <fieldset disabled className="contents">{control}</fieldset>;
  const inline = spec.kind === 'bool';
  return (
    <div className={inline ? 'flex flex-wrap items-center gap-2' : 'grid gap-1.5'}>
      {inline ? control : null}
      <Label id={`${id}-label`} htmlFor={id}>{label}</Label>
      {inline ? null : control}
      {locked ? <p id={hintId} className="text-small text-muted-foreground">{t('records.common.lockedAfterUse')}</p> : null}
      {error ? <p id={errId} className="w-full text-small text-destructive">{error}</p> : null}
    </div>
  );
}
