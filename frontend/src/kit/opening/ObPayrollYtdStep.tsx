'use client';
import { PlusIcon, Trash2Icon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import type { ObPayrollYtd } from '@/domain/types';
import { Cell, MoneyField, PartySelect } from './fields';

const blank = (): ObPayrollYtd => ({ employeeId: '', income: '', pit: '', sso: '' });

/** Step 5: each employee's income, withholding tax and social security from 1 January to the cut-off, kept so the year's payroll filings (PND.1, PND.1 kor) start from the right totals. Stored for payroll (PY2); posts nothing. */
export function ObPayrollYtdStep({ value, onChange }: { value: ObPayrollYtd[]; onChange: (v: ObPayrollYtd[]) => void }) {
  const t = useTranslations('opening.payroll');
  const patch = (i: number, p: Partial<ObPayrollYtd>) => onChange(value.map((x, k) => (k === i ? { ...x, ...p } : x)));
  return (
    <div className="grid gap-3">
      <p className="text-body text-muted-foreground">{t('hint')}</p>
      {value.map((x, i) => (
        <div key={i} className="grid grid-cols-2 items-end gap-2 rounded-lg border border-border p-3 md:grid-cols-[minmax(0,1.5fr)_9rem_9rem_9rem_var(--ctl-h)]">
          <Cell label={t('employee')} className="col-span-2 md:col-span-1"><PartySelect kind="employee" label={t('employeeN', { n: i + 1 })} value={x.employeeId} onChange={(id) => patch(i, { employeeId: id })} /></Cell>
          <Cell label={t('income')}><MoneyField label={t('incomeN', { n: i + 1 })} value={x.income} onChange={(v) => patch(i, { income: v })} /></Cell>
          <Cell label={t('pit')}><MoneyField label={t('pitN', { n: i + 1 })} value={x.pit} onChange={(v) => patch(i, { pit: v })} /></Cell>
          <Cell label={t('sso')}><MoneyField label={t('ssoN', { n: i + 1 })} value={x.sso} onChange={(v) => patch(i, { sso: v })} /></Cell>
          <Button type="button" variant="ghost" size="icon" aria-label={t('remove', { n: i + 1 })} className="justify-self-end" onClick={() => onChange(value.filter((_, k) => k !== i))}><Trash2Icon aria-hidden /></Button>
        </div>
      ))}
      <div><Button type="button" variant="outline" onClick={() => onChange([...value, blank()])}><PlusIcon aria-hidden data-icon="inline-start" />{t('add')}</Button></div>
    </div>
  );
}
