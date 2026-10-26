'use client';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useCompanyEpoch } from '@/app-shell/useCompanyEpoch';
import { isForbidden, useMe } from '@/app-shell/useMe';
import { ApiError } from '@/lib/api/client';
import { AgentReportView } from '@/kit/connect/AgentReportView';
import { ErrorState } from '@/kit/states/ErrorState';
import { ForbiddenState } from '@/kit/states/ForbiddenState';
import { LoadingState } from '@/kit/states/LoadingState';
import { NotFoundState } from '@/kit/states/NotFoundState';
import { connectApi } from '@/records/connect';

/** HC2: the stored review report of an agent's draft (SP0 §8.2). It is read, never recomputed. */
export default function AgentReportPage() {
  return <Inner key={useCompanyEpoch()} />;
}

function Inner() {
  const { id } = useParams<{ id: string }>();
  const { me, isError: meFailed, error: meError, refetch: refetchMe } = useMe();
  const q = useQuery({ queryKey: [me?.activeCompanyId ?? '', 'agent-report', id], queryFn: () => connectApi.report(id), enabled: !!me });
  if (meFailed && !me) return <ErrorState error={meError} onRetry={() => void refetchMe()} />;
  if (q.isError && !q.data) {
    if (isForbidden(q.error)) return <ForbiddenState detail={q.error instanceof ApiError ? q.error.problem.detail : undefined} />;
    if (q.error instanceof ApiError && q.error.problem.status === 404) return <NotFoundState listHref="/" />;
    return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  }
  if (!me || !q.data) return <LoadingState />;
  return <AgentReportView report={q.data} />;
}
