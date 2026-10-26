'use client';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { DESCRIPTORS } from '@/descriptors';
import { isForbidden, useMe } from '@/app-shell/useMe';
import { Button } from '@/components/ui/button';
import { routesOf } from '@/domain/descriptors';
import { isTypeAvailable } from '@/domain/doc-types';
import { HOME_NEEDS } from '@/domain/home';
import type { DocType } from '@/domain/types';
import { AgentDigest, BankSection, DeadlinesSection } from '@/kit/home/AgentDigest';
import { AlertsPanel } from '@/kit/home/AlertsPanel';
import { ApprovalsSection, DraftsSection, OverdueSection } from '@/kit/home/InboxSection';
import { KpiStrip } from '@/kit/home/KpiStrip';
import { ErrorState } from '@/kit/states/ErrorState';
import { ForbiddenState } from '@/kit/states/ForbiddenState';
import { LoadingState } from '@/kit/states/LoadingState';

/** Quick actions: sales (a tax invoice for a VAT company, an invoice for one outside VAT), a receipt, a payment voucher, an expense claim. */
const QUICK: DocType[] = ['TI', 'IV', 'RC', 'PV', 'EX'];

/**
 * Home is role-aware: a section the signed-in role cannot see is not rendered and its request is never sent (the server refuses it too). Each section owns its
 * query, so one failing or slow section never blanks the others; only the session itself (`me`) is a page-level state.
 */
export function HomeView() {
  const t = useTranslations('home');
  const tl = useTranslations('docList');
  const locale = useLocale();
  const { me, isPending, isError, error, refetch } = useMe();
  let body;
  if (isPending) body = <LoadingState rows={4} />;
  else if (isError || !me) body = isForbidden(error) ? <ForbiddenState /> : <ErrorState error={error} onRetry={() => void refetch()} />;
  else {
    const can = (s: keyof typeof HOME_NEEDS) => HOME_NEEDS[s](me.permissions, me.vatRegistered);
    const quick = QUICK.flatMap((x) => (DESCRIPTORS[x] ? [DESCRIPTORS[x]] : [])).filter((x) => me.permissions.includes(x.permissions.create) && isTypeAvailable(x.type, me.vatRegistered));
    body = (
      <>
        {quick.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {quick.map((x) => <Button key={x.type} asChild><Link href={routesOf(x).create}>{tl('create', { title: locale === 'en' ? x.titleEn : x.titleTh })}</Link></Button>)}
          </div>
        )}
        {can('kpis') && <KpiStrip />}
        {can('alerts') && <AlertsPanel />}
        <div className="grid gap-x-8 gap-y-6 lg:grid-cols-2">
          {can('approvals') && <ApprovalsSection />}
          {can('drafts') && <DraftsSection />}
          {can('overdue') && <OverdueSection />}
          {can('deadlines') && <DeadlinesSection />}
          {can('bank') && <BankSection />}
          {can('agent') && <AgentDigest />}
        </div>
      </>
    );
  }
  return (
    <div className="flex max-w-5xl flex-col gap-6">
      <h1 className="text-title font-semibold">{t('title')}</h1>
      {body}
    </div>
  );
}
