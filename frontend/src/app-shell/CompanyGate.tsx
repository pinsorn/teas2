'use client';
import { useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { useMe } from './useMe';

/** No company screen mounts until /me says the user has a company; with `activeCompanyId === null` they go to /onboarding (SP3 P8). */
export function CompanyGate({ children }: { children: ReactNode }) {
  const { account, isPending } = useMe();
  const router = useRouter();
  const none = !!account && account.activeCompanyId === null;
  useEffect(() => { if (none) router.replace('/onboarding'); }, [none, router]);
  return isPending || none ? null : <>{children}</>;
}
