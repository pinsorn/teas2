'use client';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { isForbidden, useMe } from '@/app-shell/useMe';
import type { DocType } from '@/domain/types';
import { endpoints } from '@/lib/api/endpoints';
import { formatDateBE } from '@/lib/format';
import { qk } from '@/lib/query/keys';
import { ErrorState } from '../states/ErrorState';
import { ForbiddenState } from '../states/ForbiddenState';
import { LoadingState } from '../states/LoadingState';

const KNOWN = ['create', 'issue', 'settle', 'cancel', 'revise'];

/** Newest first. An agent's action is marked and names its owner (SP0 agent-actor rule). */
export function ActivityTimeline({ type, id }: { type: DocType; id: string }) {
  const t = useTranslations('docView.activity');
  const tc = useTranslations('common');
  const { me } = useMe();
  const q = useQuery({ queryKey: qk.activity(me!.activeCompanyId, type, id), queryFn: () => endpoints.getActivity(type, id) });
  if (q.isPending) return <LoadingState rows={3} />;
  if (q.error) return isForbidden(q.error) ? <ForbiddenState permission={`doc.${type}.read`} /> : <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  if (!q.data.length) return <p className="text-body text-muted-foreground">{t('empty')}</p>;
  return (
    <ol className="grid gap-3">
      {q.data.map((a) => (
        <li key={a.id} className="grid gap-0.5">
          <div className="text-body">
            <span className="font-medium">{KNOWN.includes(a.action) ? t(`action.${a.action}`) : a.action}</span>
            {a.detail ? <span className="text-muted-foreground"> · {a.detail}</span> : null}
          </div>
          <div className="text-small text-muted-foreground">
            {a.actor.name}{a.actor.kind === 'agent' ? ` (${tc('agent')}${a.actor.ownerName ? `, ${a.actor.ownerName}` : ''})` : ''}
            {' · '}<time dateTime={a.at} className="tabular-nums">{formatDateBE(a.at.slice(0, 10))} {a.at.slice(11, 16)}</time>
          </div>
        </li>
      ))}
    </ol>
  );
}
