'use client';
import { useQuery } from '@tanstack/react-query';
import { LockIcon } from 'lucide-react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { DESCRIPTORS, docViewHref } from '@/descriptors';
import { isForbidden, useMe } from '@/app-shell/useMe';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { routesOf } from '@/domain/descriptors';
import { isTypeAvailable } from '@/domain/doc-types';
import type { DocSummary, HomeInbox, IsoDate } from '@/domain/types';
import { endpoints } from '@/lib/api/endpoints';
import { formatDateBE, formatTHB } from '@/lib/format';
import { qk } from '@/lib/query/keys';
import { VatThresholdCard } from '@/kit/tax/VatThresholdCard';

type Home = ReturnType<typeof useHome>;

/** One query, but every section owns its loading / empty / error / forbidden rendering. */
function useHome() {
  const { me } = useMe();
  const companyId = me?.activeCompanyId ?? '';
  const q = useQuery({ queryKey: qk.home(companyId), queryFn: endpoints.getHome, enabled: !!me });
  return { ...q, isPending: !me || q.isPending };
}

function Section({ id, title, home, empty, children }: {
  id: string; title: string; home: Home; empty: string | null; children: ReactNode;
}) {
  const t = useTranslations();
  let body: ReactNode;
  if (home.isPending) {
    body = (
      <div role="status" className="flex flex-col gap-2">
        <span className="sr-only">{t('common.loading')}</span>
        <Skeleton className="h-9" /><Skeleton className="h-9" />
      </div>
    );
  } else if (home.isError && isForbidden(home.error)) {
    body = (
      <Alert role="status">
        <LockIcon aria-hidden />
        <AlertTitle>{t('state.forbiddenTitle')}</AlertTitle>
        <AlertDescription>{t('state.forbiddenHint')}</AlertDescription>
      </Alert>
    );
  } else if (home.isError) {
    body = (
      <Alert variant="destructive">
        <AlertTitle>{t('state.errorTitle')}</AlertTitle>
        <AlertDescription className="text-foreground!">{home.error.message}</AlertDescription>
        <div className="mt-2"><Button variant="outline" size="sm" onClick={() => home.refetch()}>{t('common.retry')}</Button></div>
      </Alert>
    );
  } else if (empty !== null) {
    body = <p className="py-2 text-sm text-muted-foreground">{empty}</p>;
  } else {
    body = children;
  }
  return (
    <section aria-labelledby={id} className="min-w-0 border-t pt-3">
      <h2 id={id} className="pb-1 text-base font-semibold">{title}</h2>
      {body}
    </section>
  );
}

const SHOWN = 5;

/** A link to the document when its type has a route in this company; plain text otherwise (never a made-up URL). */
function DocNumber({ href, label }: { href?: string; label: string }) {
  return href
    ? <Link href={href} className="font-medium underline-offset-4 hover:underline">{label}</Link>
    : <span className="font-medium">{label}</span>;
}

function DocRows({ docs, mode }: { docs: DocSummary[]; mode: 'document' | 'overdue' }) {
  const t = useTranslations();
  return (
    <>
    <ul className="divide-y">
      {docs.slice(0, SHOWN).map((d) => (
        <li key={d.id} className="flex items-baseline justify-between gap-3 py-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <DocNumber href={docViewHref(d.type, d.id)} label={d.number ?? t('common.draftNoNumber')} />
              {d.createdByAgent && <Badge variant="secondary">{t('common.agent')}</Badge>}
            </div>
            <p className="truncate text-sm text-muted-foreground">{d.partyName}</p>
          </div>
          <div className="shrink-0 text-right text-sm tabular-nums">
            <div>{formatTHB(mode === 'overdue' ? (d.outstanding ?? d.total) : d.total)}</div>
            <div className="text-muted-foreground">
              {mode === 'overdue' && d.dueDate ? t('common.dueOn', { date: formatDateBE(d.dueDate) }) : formatDateBE(d.documentDate)}
            </div>
          </div>
        </li>
      ))}
    </ul>
    {docs.length > SHOWN && <p className="pt-2 text-sm text-muted-foreground">{t('home.more', { count: docs.length - SHOWN })}</p>}
    </>
  );
}

function Kpis({ home }: { home: Home }) {
  const t = useTranslations('home.kpi');
  const tc = useTranslations();
  if (home.isPending) {
    return <div role="status" className="grid grid-cols-2 gap-4 lg:grid-cols-4"><span className="sr-only">{tc('common.loading')}</span>{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-12" />)}</div>;
  }
  if (home.isError) return null; // each section below reports the failure with its own retry
  const k = (home.data as HomeInbox).kpis;
  const tiles: [string, string][] = [['cash', k.cash], ['ar', k.ar], ['ap', k.ap]];
  if (k.vatThisMonth !== null) tiles.push(['vat', k.vatThisMonth]);
  return (
    <dl aria-label={t('label')} className="grid grid-cols-2 gap-x-6 gap-y-3 lg:grid-cols-4">
      {tiles.map(([key, value]) => (
        <div key={key}>
          <dt className="text-sm text-muted-foreground">{t(key)}</dt>
          <dd className="text-xl font-semibold tabular-nums">{formatTHB(value)}</dd>
        </div>
      ))}
    </dl>
  );
}

export function HomeView() {
  const t = useTranslations('home');
  const home = useHome();
  const tl = useTranslations('docList');
  const locale = useLocale();
  const { me } = useMe();
  const quickCreate = Object.values(DESCRIPTORS).filter((x) => !!me && me.permissions.includes(x.permissions.create) && isTypeAvailable(x.type, me.vatRegistered));
  const d: HomeInbox | undefined = home.data;
  return (
    <div className="flex max-w-5xl flex-col gap-6">
      <h1 className="text-xl font-semibold">{t('title')}</h1>
      {quickCreate.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {quickCreate.map((x) => <Button key={x.type} asChild><Link href={routesOf(x).create}>{tl('create', { title: locale === 'en' ? x.titleEn : x.titleTh })}</Link></Button>)}
        </div>
      )}
      <VatThresholdCard />
      <Kpis home={home} />
      <div className="grid gap-x-8 gap-y-6 lg:grid-cols-2">
        <Section id="h-approvals" title={t('approvals.title')} home={home} empty={d && !d.approvals.length ? t('approvals.empty') : null}>
          <DocRows docs={d?.approvals ?? []} mode="document" />
        </Section>
        <Section id="h-drafts" title={t('drafts.title')} home={home} empty={d && !d.myDrafts.length ? t('drafts.empty') : null}>
          <DocRows docs={d?.myDrafts ?? []} mode="document" />
        </Section>
        <Section id="h-overdue" title={t('overdue.title')} home={home} empty={d && !d.overdue.length ? t('overdue.empty') : null}>
          <DocRows docs={d?.overdue ?? []} mode="overdue" />
        </Section>
        <Section id="h-deadlines" title={t('deadlines.title')} home={home} empty={d && !d.deadlines.length ? t('deadlines.empty') : null}>
          <ul className="divide-y">
            {(d?.deadlines ?? []).map((x: { form: string; due: IsoDate }) => (
              <li key={x.form} className="flex justify-between gap-3 py-2 text-sm">
                <span className="font-medium">{x.form}</span>
                <span className="tabular-nums">{formatDateBE(x.due)}</span>
              </li>
            ))}
          </ul>
        </Section>
        <Section id="h-bank" title={t('bank.title')} home={home} empty={d && !d.unreconciledLines ? t('bank.empty') : null}>
          <p className="py-2 text-sm tabular-nums">{t('bank.count', { count: d?.unreconciledLines ?? 0 })}</p>
        </Section>
        <Section id="h-agent" title={t('agent.title')} home={home} empty={d && !d.agentDigest.posted && !d.agentDigest.waiting ? t('agent.empty') : null}>
          <ul className="py-2 text-sm tabular-nums">
            <li>{t('agent.posted', { count: d?.agentDigest.posted ?? 0 })}</li>
            <li>{t('agent.waiting', { count: d?.agentDigest.waiting ?? 0 })}</li>
          </ul>
        </Section>
      </div>
    </div>
  );
}
