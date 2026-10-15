'use client';
import { DOC_TYPES, isTypeAvailable } from '@/domain/doc-types';
import type { DocType } from '@/domain/types';
import type { ReactNode } from 'react';
import { useMe } from '@/app-shell/useMe';
import { ErrorState } from '@/kit/states/ErrorState';
import { LoadingState } from '@/kit/states/LoadingState';
import { NotAvailableState } from '@/kit/states/NotAvailableState';

/** Availability is shared with the mock engine. */
export function TypeGate({ type, children }: { type: DocType; children: ReactNode }) {
  const { me, isError, error, refetch } = useMe();
  if (isError && !me) return <ErrorState error={error} onRetry={() => void refetch()} />;
  if (!me) return <LoadingState />;
  if (!isTypeAvailable(type, me.vatRegistered)) return <NotAvailableState reason={DOC_TYPES[type].vat === 'vat-only' ? 'vatOnly' : 'nonVatOnly'} />;
  return <>{children}</>;
}
