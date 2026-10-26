'use client';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useMe, isForbidden } from '@/app-shell/useMe';
import type { HomeData, HomeSection as Section } from '@/domain/types';
import { endpoints } from '@/lib/api/endpoints';
import { qk } from '@/lib/query/keys';
import { ErrorState } from '@/kit/states/ErrorState';
import { ForbiddenState } from '@/kit/states/ForbiddenState';
import { LoadingState } from '@/kit/states/LoadingState';

/** One query per Home section (its own cache key under the company's `home`), so a failure or a slow section never touches another. The view mounts a section only when the role may see it. */
export function useHomeSection<S extends Section>(section: S): UseQueryResult<HomeData[S]> {
  const { me } = useMe();
  return useQuery({ queryKey: [...qk.home(me?.activeCompanyId ?? ''), section], queryFn: () => endpoints.getHome(section), enabled: !!me });
}

/** The frame of a Home section: heading, then its own loading / forbidden / error (retry) / empty / content. */
export function HomeSectionShell<T>({ id, title, q, isEmpty, empty, rows = 2, children }: {
  id: string; title: string; q: UseQueryResult<T>; isEmpty: (d: T) => boolean; empty: string; rows?: number; children: (d: T) => ReactNode;
}) {
  let body: ReactNode;
  if (q.isPending) body = <LoadingState rows={rows} />;
  else if (q.isError) body = isForbidden(q.error) ? <ForbiddenState /> : <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  else if (isEmpty(q.data)) body = <p data-screen-state="empty" className="py-2 text-small text-muted-foreground">{empty}</p>;
  else body = children(q.data);
  return (
    <section aria-labelledby={id} className="min-w-0 border-t pt-3">
      <h2 id={id} className="pb-1 text-section font-semibold">{title}</h2>
      {body}
    </section>
  );
}
