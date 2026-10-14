'use client';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { ApiError } from '@/lib/api/client';
import { endpoints } from '@/lib/api/endpoints';
import { qk } from '@/lib/query/keys';
import { NAV, visibleNav } from './nav';

export const isForbidden = (e: unknown) => e instanceof ApiError && e.problem.status === 403;

/** The signed-in user and the nav they can see in the active company. Nav is never computed from another company's data. */
export function useMe() {
  const q = useQuery({ queryKey: qk.me(), queryFn: endpoints.getMe });
  const me = q.data;
  const groups = useMemo(
    () => (me ? visibleNav(NAV, { permissions: me.permissions, vatRegistered: me.vatRegistered }) : []),
    [me],
  );
  return { ...q, me, groups };
}
