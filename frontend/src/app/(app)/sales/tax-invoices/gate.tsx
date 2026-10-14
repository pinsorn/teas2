'use client';
import type { ReactNode } from 'react';
import { useMe } from '@/app-shell/useMe';
import { ErrorState } from '@/kit/states/ErrorState';
import { LoadingState } from '@/kit/states/LoadingState';
import { NotAvailableState } from '@/kit/states/NotAvailableState';

/** The tax invoice is VAT-only: every /sales/tax-invoices route renders NotAvailableState on a non-VAT company. */
export function VatGate({ children }: { children: ReactNode }) {
  const { me, isError, error, refetch } = useMe();
  if (isError && !me) return <ErrorState error={error} onRetry={() => void refetch()} />;
  if (!me) return <LoadingState />;
  if (!me.vatRegistered) return <NotAvailableState />;
  return <>{children}</>;
}
