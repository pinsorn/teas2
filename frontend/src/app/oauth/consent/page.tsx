'use client';
import { useMutation, useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Suspense } from 'react';
import { Alert, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { isForbidden, useMe } from '@/app-shell/useMe';
import { PERMISSIONS } from '@/domain/permissions';
import { ApiError } from '@/lib/api/client';
import { ErrorState } from '@/kit/states/ErrorState';
import { ForbiddenState } from '@/kit/states/ForbiddenState';
import { LoadingState } from '@/kit/states/LoadingState';
import { connectApi } from '@/records/connect';

/** HC2: where an AI client asks to be connected to a company (OAuth 2.1 consent). Outside the app shell: it is a page of its own, reached from the client. */
export default function ConsentPage() {
  return <main id="content" className="mx-auto grid max-w-xl gap-4 p-4 md:p-8"><Suspense fallback={<LoadingState rows={3} />}><Inner /></Suspense></main>;
}

function Inner() {
  const t = useTranslations('connect.consent');
  const client = useSearchParams().get('client') ?? '';
  const { me, isError: meFailed, error: meError, refetch: refetchMe } = useMe();
  const q = useQuery({ queryKey: [me?.activeCompanyId ?? '', 'oauth-consent', client], queryFn: () => connectApi.consentInfo(client), enabled: !!me && !!client, retry: false });
  const decide = useMutation({ mutationFn: (d: 'approve' | 'deny') => connectApi.consent(client, d) });
  if (!client) return <Alert role="alert" data-screen-state="error"><AlertTitle>{t('noClient')}</AlertTitle></Alert>;
  if (meFailed && !me) return <ErrorState error={meError} onRetry={() => void refetchMe()} />;
  if (q.isError && !q.data) {
    if (isForbidden(q.error)) return <ForbiddenState permission="connect.manage" detail={q.error instanceof ApiError ? q.error.problem.detail : undefined} />;
    if (q.error instanceof ApiError && q.error.problem.status === 404) return <Alert role="alert" data-screen-state="not-found"><AlertTitle>{t('unknown')}</AlertTitle></Alert>;
    return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  }
  if (!me || !q.data) return <LoadingState rows={3} />;
  const info = q.data;
  const label = (c: string) => PERMISSIONS[c]?.th ?? c;
  if (decide.data) {
    return (
      <div className="grid gap-3">
        <h1 className="text-title font-semibold">{decide.data.status === 'approved' ? t('approvedTitle', { name: info.client.name }) : t('deniedTitle')}</h1>
        <p role="status" className="text-body text-muted-foreground">{decide.data.status === 'approved' ? t('approvedBody', { company: info.company.name }) : t('deniedBody')}</p>
        <Button asChild variant="outline" className="w-fit"><Link href="/settings/connect?tab=apps">{t('toApps')}</Link></Button>
      </div>
    );
  }
  return (
    <div className="grid gap-4">
      <div>
        <h1 className="text-title font-semibold">{t('title', { name: info.client.name })}</h1>
        <p className="text-body text-muted-foreground">{t('lead', { company: info.company.name, owner: info.owner.name })}</p>
      </div>
      <section aria-labelledby="co-granted" className="grid gap-2 rounded-lg border bg-card p-4">
        <h2 id="co-granted" className="text-section font-semibold">{t('granted')}</h2>
        <p className="text-small text-muted-foreground">{t('limited', { owner: info.owner.name })}</p>
        {info.granted.length ? <ul className="ml-5 list-disc" data-testid="granted">{info.granted.map((c) => <li key={c}>{label(c)}</li>)}</ul> : <p>{t('none')}</p>}
      </section>
      {info.notGranted.length ? (
        <section aria-labelledby="co-denied" className="grid gap-2 rounded-lg border bg-card p-4">
          <h2 id="co-denied" className="text-section font-semibold">{t('notGranted')}</h2>
          <ul className="ml-5 list-disc text-muted-foreground" data-testid="not-granted">{info.notGranted.map((c) => <li key={c}>{label(c)}</li>)}</ul>
        </section>
      ) : null}
      <p className="text-small text-muted-foreground">{t('never')}</p>
      {decide.isError ? <Alert variant="destructive" role="alert"><AlertTitle>{decide.error instanceof ApiError ? decide.error.problem.title : t('failed')}</AlertTitle></Alert> : null}
      <div className="flex flex-wrap gap-2">
        <Button disabled={decide.isPending} onClick={() => decide.mutate('approve')}>{t('approve')}</Button>
        <Button variant="outline" disabled={decide.isPending} onClick={() => decide.mutate('deny')}>{t('deny')}</Button>
      </div>
    </div>
  );
}
