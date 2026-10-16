'use client';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useCompanyEpoch } from '@/app-shell/useCompanyEpoch';
import { isForbidden, useMe } from '@/app-shell/useMe';
import { Checkbox } from '@/components/ui/checkbox';
import type { DocDescriptor } from '@/domain/descriptors';
import { isTypeAvailable } from '@/domain/doc-types';
import type { Allocation, Money, OpenItem } from '@/domain/types';
import { ApiError } from '@/lib/api/client';
import { endpoints } from '@/lib/api/endpoints';
import { formatDateBE, formatMoney } from '@/lib/format';
import { qk } from '@/lib/query/keys';
import { EmptyState } from '../states/EmptyState';
import { ErrorState } from '../states/ErrorState';
import { ForbiddenState } from '../states/ForbiddenState';
import { LoadingState } from '../states/LoadingState';
import { settleable } from './SettlementPanel';

export interface GroupPanelProps {
  descriptor: DocDescriptor;
  partyId?: string;
  value: Allocation[];
  onChange: (a: Allocation[]) => void;
  /** The server's total for the current list: shown as is, the browser never sums the rows. */
  total?: Money;
  readOnly?: boolean;
}

/** Keyed by the active company: a switch drops the open items and the ticks of the other company. */
export function GroupPanel(props: GroupPanelProps) {
  return <GroupPanelInner key={useCompanyEpoch()} {...props} />;
}

/** The documents a billing statement groups: the customer's open TI / IV. The server filters the party, the company and what is still owed; the amount of a tick is a copy of its outstanding string. */
function GroupPanelInner({ descriptor: d, partyId, value, onChange, total, readOnly }: GroupPanelProps) {
  const t = useTranslations('docEditor.group');
  const { me } = useMe();
  const companyId = me?.activeCompanyId ?? '';
  const types = (d.groups ?? []).filter((x) => me && isTypeAvailable(x, me.vatRegistered));
  const q = useQuery({
    queryKey: qk.openItems(companyId, partyId ?? '', types.join(',')),
    queryFn: () => endpoints.openItems({ partyId: partyId!, types }),
    enabled: !!me && !!partyId && !readOnly && types.length > 0,
  });
  const shell = (body: React.ReactNode) => (
    <section aria-label={t('title')} className="grid gap-3 rounded-xl bg-card p-4 ring-1 ring-foreground/10">
      <h2 className="text-section font-semibold">{t('title')}</h2>
      {body}
    </section>
  );
  const totalLine = (
    <p className="flex flex-wrap gap-x-6 gap-y-1 text-body" role="status">
      <span><span className="text-muted-foreground">{t('total')} </span><span className="tabular-nums font-semibold">{total !== undefined ? formatMoney(total) : '–'}</span></span>
    </p>
  );

  if (readOnly) {
    return shell(
      <>
        <ul className="grid gap-1">
          {value.map((a) => (
            <li key={a.targetId} className="flex flex-wrap justify-between gap-x-4">
              <span>{a.targetNumber ?? a.targetId}</span><span className="tabular-nums">{formatMoney(a.amount)}</span>
            </li>
          ))}
        </ul>
        {totalLine}
      </>,
    );
  }
  if (!partyId) return shell(<p className="text-muted-foreground">{t('pickParty')}</p>);
  if (q.isPending) return shell(<LoadingState rows={3} />);
  if (q.isError) {
    return shell(isForbidden(q.error) ? <ForbiddenState detail={(q.error as ApiError).problem.detail} /> : <ErrorState error={q.error} onRetry={() => void q.refetch()} />);
  }

  // open items first; a ticked target that is no longer open still shows (so it can be unticked)
  const open = q.data.items;
  const rows: { id: string; type: Allocation['targetType']; number: string; dueDate?: string; total?: string; outstanding?: string }[] = [
    ...open.map((i: OpenItem) => ({ id: i.id, type: i.type, number: i.number, dueDate: i.dueDate, total: i.total, outstanding: i.outstanding })),
    ...value.filter((a) => !open.some((i) => i.id === a.targetId)).map((a) => ({ id: a.targetId, type: a.targetType, number: a.targetNumber ?? a.targetId })),
  ];
  if (!rows.length) return shell(<><EmptyState title={t('empty')} />{totalLine}</>);

  return shell(
    <>
      <div className="overflow-x-auto">
        <table className="w-full text-body">
          <thead className="text-small text-muted-foreground">
            <tr>
              <th className="w-8" /><th className="px-2 py-1 text-left font-medium">{t('number')}</th><th className="px-2 py-1 text-left font-medium">{t('due')}</th>
              <th className="px-2 py-1 text-right font-medium">{t('docTotal')}</th><th className="px-2 py-1 text-right font-medium">{t('outstanding')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const picked = value.some((x) => x.targetId === r.id);
              return (
                <tr key={r.id} className="border-t border-border align-top">
                  <td className="py-2 pr-1">
                    <Checkbox aria-label={t('pick', { number: r.number })} checked={picked} disabled={!picked && !(r.outstanding && settleable(r.outstanding))}
                      onCheckedChange={(on) => onChange(on === true
                        ? [...value, { targetId: r.id, targetType: r.type, targetNumber: r.number, amount: r.outstanding! }] // a copy of the server's string
                        : value.filter((x) => x.targetId !== r.id))} />
                  </td>
                  <td className="px-2 py-2 tabular-nums">{r.number}</td>
                  <td className="px-2 py-2">{r.dueDate ? formatDateBE(r.dueDate) : ''}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{r.total ? formatMoney(r.total) : ''}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{r.outstanding ? formatMoney(r.outstanding) : ''}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {totalLine}
    </>,
  );
}
