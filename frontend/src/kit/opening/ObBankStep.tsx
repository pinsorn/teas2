'use client';
import { useQuery } from '@tanstack/react-query';
import { PlusIcon, Trash2Icon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useMe } from '@/app-shell/useMe';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { ObBank } from '@/domain/types';
import { endpoints } from '@/lib/api/endpoints';
import { Cell, MoneyField, selectCls } from './fields';

const blankItem = (): ObBank['inTransit'][number] => ({ kind: 'deposit', date: '', description: '', amount: '' });

/** Step 2: per bank / cash account the statement balance at the cut-off and its in-transit items (deposits in transit, outstanding payments). The GL line is statement + deposits - payments, stated by the server in the check; issuing starts
 *  the account's reconciliation the day after the cut-off, and the in-transit items match the first statement like a receipt / voucher. */
export function ObBankStep({ value, onChange }: { value: ObBank[]; onChange: (v: ObBank[]) => void }) {
  const t = useTranslations('opening.bank');
  const { me } = useMe();
  const accounts = useQuery({ queryKey: [me?.activeCompanyId ?? '', 'opening-bank-accounts'], queryFn: () => endpoints.listRecords('bank-account', { limit: 100 }), enabled: !!me });
  const patch = (i: number, p: Partial<ObBank>) => onChange(value.map((b, k) => (k === i ? { ...b, ...p } : b)));
  const patchItem = (i: number, j: number, p: Partial<ObBank['inTransit'][number]>) => patch(i, { inTransit: value[i].inTransit.map((x, k) => (k === j ? { ...x, ...p } : x)) });
  const free = (accounts.data?.items ?? []).filter((a) => a.active && !value.some((b) => b.accountId === a.id));
  return (
    <div className="grid gap-4">
      <p className="text-body text-muted-foreground">{t('hint')}</p>
      {value.map((b, i) => (
        <section key={i} aria-label={t('section', { n: i + 1 })} className="grid gap-3 rounded-lg border border-border p-3">
          <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_12rem_var(--ctl-h)] md:items-end">
            <Cell label={t('account')}>
              <select aria-label={t('accountN', { n: i + 1 })} className={selectCls} value={b.accountId} onChange={(e) => patch(i, { accountId: e.target.value })}>
                <option value=""></option>
                {(accounts.data?.items ?? []).filter((a) => a.id === b.accountId || free.includes(a)).map((a) => <option key={a.id} value={a.id}>{String(a.name)}{a.accountNo ? ` ${String(a.accountNo)}` : ''}</option>)}
              </select>
            </Cell>
            <Cell label={t('statement')}><MoneyField label={t('statementN', { n: i + 1 })} value={b.statement} onChange={(v) => patch(i, { statement: v })} /></Cell>
            <Button type="button" variant="ghost" size="icon" aria-label={t('removeAccount', { n: i + 1 })} onClick={() => onChange(value.filter((_, k) => k !== i))}><Trash2Icon aria-hidden /></Button>
          </div>
          <p className="text-small font-medium">{t('inTransit')}</p>
          {b.inTransit.map((x, j) => (
            <div key={j} className="grid grid-cols-2 gap-2 md:grid-cols-[13rem_9rem_minmax(0,1fr)_9rem_var(--ctl-h)] md:items-end">
              <Cell label={t('kind')} className="col-span-2 md:col-span-1">
                <select aria-label={t('kindN', { n: j + 1 })} className={selectCls} value={x.kind} onChange={(e) => patchItem(i, j, { kind: e.target.value as 'deposit' | 'payment' })}>
                  <option value="deposit">{t('deposit')}</option><option value="payment">{t('payment')}</option>
                </select>
              </Cell>
              <Cell label={t('date')}><Input type="date" aria-label={t('dateN', { n: j + 1 })} value={x.date} onChange={(e) => patchItem(i, j, { date: e.target.value })} /></Cell>
              <Cell label={t('description')} className="col-span-2 md:col-span-1"><Input aria-label={t('descriptionN', { n: j + 1 })} value={x.description} onChange={(e) => patchItem(i, j, { description: e.target.value })} /></Cell>
              <Cell label={t('amount')}><MoneyField label={t('amountN', { n: j + 1 })} value={x.amount} onChange={(v) => patchItem(i, j, { amount: v })} /></Cell>
              <Button type="button" variant="ghost" size="icon" aria-label={t('removeItem', { n: j + 1 })} onClick={() => patch(i, { inTransit: b.inTransit.filter((_, k) => k !== j) })}><Trash2Icon aria-hidden /></Button>
            </div>
          ))}
          <div><Button type="button" variant="outline" size="sm" onClick={() => patch(i, { inTransit: [...b.inTransit, blankItem()] })}><PlusIcon aria-hidden data-icon="inline-start" />{t('addItem')}</Button></div>
        </section>
      ))}
      <div><Button type="button" variant="outline" disabled={!free.length} onClick={() => onChange([...value, { accountId: '', statement: '', inTransit: [] }])}><PlusIcon aria-hidden data-icon="inline-start" />{t('addAccount')}</Button></div>
    </div>
  );
}
