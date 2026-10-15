'use client';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useCompanyEpoch } from '@/app-shell/useCompanyEpoch';
import { isForbidden, useMe } from '@/app-shell/useMe';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import type { DocDescriptor } from '@/domain/descriptors';
import type { Allocation, ComputeResult, OpenItem } from '@/domain/types';
import { ApiError } from '@/lib/api/client';
import { endpoints } from '@/lib/api/endpoints';
import { formatDateBE, formatMoney } from '@/lib/format';
import { qk } from '@/lib/query/keys';
import { EmptyState } from '../states/EmptyState';
import { ErrorState } from '../states/ErrorState';
import { ForbiddenState } from '../states/ForbiddenState';
import { LoadingState } from '../states/LoadingState';
import { cleanDecimal, moneyText } from './useLineGridKeys';

export interface SettlementPanelProps {
  descriptor: DocDescriptor;
  partyId?: string;
  value: Allocation[];
  onChange: (a: Allocation[]) => void;
  /** The server's answer for the current input: shown as is, the browser never sums the rows. */
  allocation?: ComputeResult['allocation'];
  readOnly?: boolean;
}

/** Keyed by the active company: a switch drops the open items and the ticks of the other company. */
export function SettlementPanel(props: SettlementPanelProps) {
  return <SettlementPanelInner key={useCompanyEpoch()} {...props} />;
}

/** Zero or negative outstanding cannot be settled; read from the server string, not computed. */
export const settleable = (outstanding: string) => !outstanding.startsWith('-') && !/^0+(\.0+)?$/.test(outstanding);

function SettlementPanelInner({ descriptor: d, partyId, value, onChange, allocation, readOnly }: SettlementPanelProps) {
  const t = useTranslations('docEditor.settlement');
  const { me } = useMe();
  const companyId = me?.activeCompanyId ?? '';
  const types = d.settles ?? [];
  const q = useQuery({
    queryKey: qk.openItems(companyId, partyId ?? '', types.join(',')),
    queryFn: () => endpoints.openItems({ partyId: partyId!, types }),
    enabled: !!me && !!partyId && !readOnly,
  });
  const withholds = d.type === 'RC'; // the customer withholds on a receipt; a voucher withholds from its own lines
  const patch = (targetId: string, p: Partial<Allocation>) => onChange(value.map((a) => (a.targetId === targetId ? { ...a, ...p } : a)));

  const totals = (
    <p className="flex flex-wrap gap-x-6 gap-y-1 text-body" role="status">
      <span><span className="text-muted-foreground">{t('allocated')} </span><span className="tabular-nums font-semibold">{allocation ? formatMoney(allocation.allocated) : '–'}</span></span>
      <span><span className="text-muted-foreground">{t('unallocated')} </span><span className="tabular-nums font-semibold">{allocation ? formatMoney(allocation.unallocated) : '–'}</span></span>
    </p>
  );
  const shell = (body: React.ReactNode) => (
    <section aria-label={t('title')} className="grid gap-3 rounded-xl bg-card p-4 ring-1 ring-foreground/10">
      <h2 className="text-section font-semibold">{t('title')}</h2>
      {body}
    </section>
  );

  if (readOnly) {
    return shell(
      <>
        <ul className="grid gap-1">
          {value.map((a) => (
            <li key={a.targetId} className="flex flex-wrap justify-between gap-x-4">
              <span>{a.targetNumber ?? a.targetId}</span>
              <span className="tabular-nums">{formatMoney(a.amount)}{a.wht ? ` · ${t('wht')} ${formatMoney(a.wht)}` : ''}</span>
            </li>
          ))}
        </ul>
        {totals}
      </>,
    );
  }
  if (!partyId) return shell(<p className="text-muted-foreground">{t('pickParty')}</p>);
  if (q.isPending) return shell(<LoadingState rows={3} />);
  if (q.isError) {
    return shell(isForbidden(q.error)
      ? <ForbiddenState detail={(q.error as ApiError).problem.detail} />
      : <ErrorState error={q.error} onRetry={() => void q.refetch()} />);
  }

  // open items first; an allocation whose target is no longer open still shows (so it can be unticked)
  const open = q.data.items;
  const rows: { id: string; type: Allocation['targetType']; number: string; dueDate?: string; total?: string; outstanding?: string }[] = [
    ...open.map((i: OpenItem) => ({ id: i.id, type: i.type, number: i.number, dueDate: i.dueDate, total: i.total, outstanding: i.outstanding })),
    ...value.filter((a) => !open.some((i) => i.id === a.targetId)).map((a) => ({ id: a.targetId, type: a.targetType, number: a.targetNumber ?? a.targetId })),
  ];
  if (!rows.length) return shell(<><EmptyState title={t('empty')} />{totals}</>);

  return shell(
    <>
      <div className="overflow-x-auto">
        <table className="w-full text-body">
          <thead className="text-small text-muted-foreground">
            <tr>
              <th className="w-8" /><th className="px-2 py-1 text-left font-medium">{t('number')}</th><th className="px-2 py-1 text-left font-medium">{t('due')}</th>
              <th className="px-2 py-1 text-right font-medium">{t('total')}</th><th className="px-2 py-1 text-right font-medium">{t('outstanding')}</th>
              <th className="px-2 py-1 text-right font-medium">{t('amount')}</th>{withholds && <th className="px-2 py-1 text-right font-medium">{t('wht')}</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const a = value.find((x) => x.targetId === r.id);
              const hint = a && withholds ? allocation?.suggestedWht.find((s) => s.targetId === r.id) : undefined;
              return (
                <tr key={r.id} className="border-t border-border align-top">
                  <td className="py-2 pr-1">
                    <Checkbox aria-label={t('pick', { number: r.number })} checked={!!a} disabled={!a && !(r.outstanding && settleable(r.outstanding))}
                      onCheckedChange={(on) => onChange(on === true
                        // the amount is a copy of the server's outstanding string, never computed here
                        ? [...value, { targetId: r.id, targetType: r.type, targetNumber: r.number, amount: r.outstanding! }]
                        : value.filter((x) => x.targetId !== r.id))} />
                  </td>
                  <td className="px-2 py-2 tabular-nums">{r.number}</td>
                  <td className="px-2 py-2">{r.dueDate ? formatDateBE(r.dueDate) : ''}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{r.total ? formatMoney(r.total) : ''}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{r.outstanding ? formatMoney(r.outstanding) : ''}</td>
                  <td className="px-2 py-1 text-right">
                    {a && <Input type="text" inputMode="decimal" autoComplete="off" className="text-right tabular-nums" aria-label={t('amountOf', { number: r.number })} value={a.amount}
                      onChange={(e) => patch(r.id, { amount: cleanDecimal(e.target.value, 2) })}
                      onBlur={() => { if (moneyText(a.amount) !== a.amount) patch(r.id, { amount: moneyText(a.amount) }); }} onFocus={(e) => e.target.select()} />}
                  </td>
                  {withholds && (
                    <td className="px-2 py-1 text-right">
                      {a && (
                        <div className="grid gap-1">
                          <Input type="text" inputMode="decimal" autoComplete="off" className="text-right tabular-nums" aria-label={t('whtOf', { number: r.number })} value={a.wht ?? ''}
                            onChange={(e) => patch(r.id, { wht: cleanDecimal(e.target.value, 2) || undefined })}
                            onBlur={() => { if (a.wht && moneyText(a.wht) !== a.wht) patch(r.id, { wht: moneyText(a.wht) }); }} onFocus={(e) => e.target.select()} />
                          {hint && hint.wht !== a.wht && (
                            <Button type="button" size="sm" variant="ghost" onClick={() => patch(r.id, { wht: hint.wht, ...(hint.whtTypeCode ? { whtTypeCode: hint.whtTypeCode } : {}) })}>
                              {t('suggest', { wht: formatMoney(hint.wht) })}
                            </Button>
                          )}
                          {a.wht && <Input type="text" autoComplete="off" aria-label={t('certOf', { number: r.number })} placeholder={t('cert')} value={a.certNumber ?? ''}
                            onChange={(e) => patch(r.id, { certNumber: e.target.value || undefined })} />}
                        </div>
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {totals}
    </>,
  );
}
