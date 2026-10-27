'use client';
import { useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { useMe } from './useMe';

/** A user whose /me says `activeCompanyId === null` mounts no company screen and goes to /onboarding (SP3 P8). */
export function CompanyGate({ children }: { children: ReactNode }) {
  const { account } = useMe();
  const router = useRouter();
  const none = !!account && account.activeCompanyId === null;
  useEffect(() => { if (none) router.replace('/onboarding'); }, [none, router]);
  // only a known company-less user is held back: while /me loads or fails, the screens show their own loading / error states
  return none ? null : <>{children}</>;
}
