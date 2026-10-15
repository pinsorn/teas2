'use client';
import { LockIcon } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { matchNavItem } from './nav';
import { useMe } from './useMe';

/** Placeholder for a navigation route that is not built yet. Distinguishes loading, error and forbidden from "not built". */
export function ComingInSp1c({ title, href }: { title: string; href?: string }) {
  const t = useTranslations();
  const { groups, isPending, isError, error, refetch } = useMe();
  const allowed = !href || groups.some((g) => g.items.some((i) => i.href === matchNavItem(href)?.item.href));

  let body;
  if (isPending) {
    body = (
      <div role="status" className="flex flex-col gap-2">
        <span className="sr-only">{t('common.loading')}</span>
        <Skeleton className="h-5 w-2/3" />
        <Skeleton className="h-5 w-1/2" />
      </div>
    );
  } else if (isError) {
    body = (
      <Alert variant="destructive">
        <AlertTitle>{t('state.errorTitle')}</AlertTitle>
        <AlertDescription className="text-foreground!">{error.message}</AlertDescription>
        <div className="mt-2"><Button variant="outline" size="sm" onClick={() => refetch()}>{t('common.retry')}</Button></div>
      </Alert>
    );
  } else if (!allowed) {
    body = (
      <Alert role="status">
        <LockIcon aria-hidden />
        <AlertTitle>{t('state.forbiddenTitle')}</AlertTitle>
        <AlertDescription>{t('state.forbiddenHint')}</AlertDescription>
      </Alert>
    );
  } else {
    body = (
      <div data-screen-state="coming" className="flex flex-col items-start gap-3">
        <h2 className="text-base font-medium">{t('shell.comingTitle')}</h2>
        <p className="max-w-prose text-sm text-muted-foreground">{t('shell.comingBody', { title })}</p>
        <Button variant="outline" asChild><Link href="/">{t('shell.comingBack')}</Link></Button>
      </div>
    );
  }
  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <h1 className="text-xl font-semibold">{title}</h1>
      {body}
    </div>
  );
}
