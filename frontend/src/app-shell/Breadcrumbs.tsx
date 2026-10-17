'use client';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Fragment, type ReactNode } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { descriptorByPath } from '@/descriptors';
import type { DocDescriptor } from '@/domain/descriptors';
import { endpoints } from '@/lib/api/endpoints';
import { qk } from '@/lib/query/keys';
import { matchNavItem } from './nav';
import { useMe } from './useMe';

const safeDecode = (s: string) => { try { return decodeURIComponent(s); } catch { return s; } };

/** The document's number (or "ร่าง" for a draft). Same query as DocView, so it is usually already cached. Never the id. */
function DocCrumb({ d, id }: { d: DocDescriptor; id: string }) {
  const t = useTranslations('shell.crumb');
  const { me, error: meError } = useMe();
  const q = useQuery({ queryKey: qk.doc(me?.activeCompanyId ?? '', d.type, id), queryFn: () => endpoints.getDoc(d.type, id), enabled: !!me });
  if (q.isPending && !meError) return <Skeleton className="inline-block h-4 w-24 align-middle" />;
  return <>{q.data ? (q.data.number ?? t('draft')) : d.type}</>;
}

/** A schedule's name (same query as its page), never its id. */
function ScheduleCrumb({ id }: { id: string }) {
  const { me, error: meError } = useMe();
  const q = useQuery({ queryKey: qk.record(me?.activeCompanyId ?? '', 'schedule', id), queryFn: () => endpoints.getRecord('schedule', id), enabled: !!me });
  if (q.isPending && !meError) return <Skeleton className="inline-block h-4 w-24 align-middle" />;
  return <>{q.data ? String((q.data as { name?: string }).name ?? id) : id}</>;
}

/** Group > list page (link) > document (current) [> edit]. */
export function Breadcrumbs() {
  const t = useTranslations();
  const pathname = usePathname();
  const hit = matchNavItem(pathname);
  const rest = hit ? pathname.slice(hit.item.href === '/' ? 1 : hit.item.href.length).split('/').filter(Boolean) : [];
  const d = hit ? descriptorByPath(hit.item.href) : undefined;
  const crumbs: { label: ReactNode; href?: string }[] = [];
  if (hit && hit.group.key !== 'home') crumbs.push({ label: t(hit.group.labelKey) });
  if (hit) crumbs.push({ label: t(hit.item.labelKey), href: rest.length ? hit.item.href : undefined });
  rest.forEach((s, i) => crumbs.push({
    label: i === 0 && d && s !== 'new' ? <DocCrumb d={d} id={safeDecode(s)} />
      : i === 0 && hit?.item.href === '/accounting/schedules' ? <ScheduleCrumb id={safeDecode(s)} />
      : s === 'edit' || s === 'new' || s === 'template' ? t(`shell.crumb.${s}`) : safeDecode(s),
    href: i < rest.length - 1 ? `${hit?.item.href}/${rest.slice(0, i + 1).join('/')}` : undefined,
  }));

  return (
    <nav aria-label={t('shell.breadcrumbLabel')} className="min-w-0">
      <ol className="flex items-center gap-1.5 text-sm">
        {crumbs.map((c, i) => (
          <Fragment key={i}>
            {i > 0 && <li aria-hidden className="text-muted-foreground">/</li>}
            <li className="min-w-0 truncate">
              {c.href ? (
                <Link href={c.href} className="underline-offset-4 hover:underline">{c.label}</Link>
              ) : (
                <span
                  aria-current={i === crumbs.length - 1 ? 'page' : undefined}
                  className={i === crumbs.length - 1 ? 'font-medium' : 'text-muted-foreground'}
                >
                  {c.label}
                </span>
              )}
            </li>
          </Fragment>
        ))}
      </ol>
    </nav>
  );
}
