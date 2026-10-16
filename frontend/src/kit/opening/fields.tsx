'use client';
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useMe } from '@/app-shell/useMe';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { endpoints } from '@/lib/api/endpoints';
import { cleanDecimal, moneyText } from '../doc-editor/useLineGridKeys';

export const selectCls = 'h-(--ctl-h) w-full rounded-lg border border-input bg-card px-3 text-body outline-none';

/** A labelled cell of a step row (the label shows on a phone, where a row is a card; the desktop header row names the columns). */
export function Cell({ label, children, className = '' }: { label: string; children: ReactNode; className?: string }) {
  return <div className={`grid min-w-0 gap-1 ${className}`}><Label className="text-small text-muted-foreground md:sr-only">{label}</Label>{children}</div>;
}

/** Money typed as text (2 decimals on blur), the way the line grids take it. */
export function MoneyField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return <Input type="text" inputMode="decimal" autoComplete="off" aria-label={label} className="text-right tabular-nums" placeholder="0.00" value={value}
    onChange={(e) => onChange(cleanDecimal(e.target.value, 2))} onBlur={() => { if (value && moneyText(value) !== value) onChange(moneyText(value)); }} onFocus={(e) => e.target.select()} />;
}

/** Party id -> name for the three kinds (a summary shows names, the stored steps hold ids). */
export function usePartyNames(enabled = true): (id: string) => string {
  const { me } = useMe();
  const of = (kind: 'customer' | 'vendor' | 'employee') => ({ queryKey: [me?.activeCompanyId ?? '', 'opening-parties', kind], queryFn: () => endpoints.searchParties({ kind, limit: 200 }), enabled: !!me && enabled });
  const all = [...(useQuery(of('customer')).data?.items ?? []), ...(useQuery(of('vendor')).data?.items ?? []), ...(useQuery(of('employee')).data?.items ?? [])];
  return (id) => all.find((p) => p.id === id)?.name ?? id;
}

/** The company's parties of one kind (a customer / vendor / employee picker). */
export function PartySelect({ kind, label, value, onChange }: { kind: 'customer' | 'vendor' | 'employee'; label: string; value: string; onChange: (id: string) => void }) {
  const { me } = useMe();
  const q = useQuery({ queryKey: [me?.activeCompanyId ?? '', 'opening-parties', kind], queryFn: () => endpoints.searchParties({ kind, limit: 200 }), enabled: !!me });
  const items = q.data?.items ?? [];
  return (
    <select aria-label={label} className={selectCls} value={value} disabled={!q.data} onChange={(e) => onChange(e.target.value)}>
      <option value="">{q.isError ? '!' : q.data ? '' : '…'}</option>
      {value && !items.some((p) => p.id === value) ? <option value={value}>{value}</option> : null}
      {items.map((p) => <option key={p.id} value={p.id}>{p.code} {p.name}</option>)}
    </select>
  );
}
