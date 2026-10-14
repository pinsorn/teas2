'use client';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useMe, isForbidden } from '@/app-shell/useMe';
import type { DocType } from '@/domain/types';
import { endpoints } from '@/lib/api/endpoints';
import { formatDateBE, formatMoney } from '@/lib/format';
import { qk } from '@/lib/query/keys';
import { ErrorState } from '../states/ErrorState';
import { ForbiddenState } from '../states/ForbiddenState';
import { LoadingState } from '../states/LoadingState';

/** The journal entries the document produced (originals, reversals, corrections), exactly as the server posted them. */
export function LedgerTab({ type, id }: { type: DocType; id: string }) {
  const t = useTranslations('docView.ledger');
  const { me } = useMe();
  const q = useQuery({ queryKey: qk.ledger(me!.activeCompanyId, type, id), queryFn: () => endpoints.getLedger(type, id) });
  if (q.isPending) return <LoadingState rows={3} />;
  if (q.error) return isForbidden(q.error) ? <ForbiddenState permission="ledger.read" /> : <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  if (!q.data.entries.length) return <p className="text-body text-muted-foreground">{t('empty')}</p>;
  return (
    <div className="grid gap-4">
      {q.data.entries.map((e, i) => (
        <section key={`${e.number ?? i}-${e.kind}`} className="grid gap-1">
          <h3 className="text-body font-medium">
            {t(`kind.${e.kind}`)}{e.number ? ` ${e.number}` : ''} <span className="font-normal text-muted-foreground">{formatDateBE(e.date)}</span>
          </h3>
          <table className="w-full text-body">
            <thead>
              <tr className="border-b text-left text-small text-muted-foreground">
                <th scope="col" className="py-1 font-medium">{t('account')}</th>
                <th scope="col" className="py-1 text-right font-medium">{t('debit')}</th>
                <th scope="col" className="py-1 text-right font-medium">{t('credit')}</th>
              </tr>
            </thead>
            <tbody>
              {e.lines.map((l, j) => (
                <tr key={j} className="border-b border-border/50">
                  <td className="py-1"><span className="tabular-nums">{l.accountCode}</span> {l.accountName}{l.partyName ? <span className="text-muted-foreground"> · {l.partyName}</span> : null}</td>
                  <td className="py-1 text-right tabular-nums">{l.debit !== '0.00' ? formatMoney(l.debit) : ''}</td>
                  <td className="py-1 text-right tabular-nums">{l.credit !== '0.00' ? formatMoney(l.credit) : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </div>
  );
}
