'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Fragment } from 'react';
import { matchNavItem } from './nav';

const safeDecode = (s: string) => { try { return decodeURIComponent(s); } catch { return s; } };

/** Group > list page (link) > document (current). Document numbers arrive as the last path segment. */
export function Breadcrumbs() {
  const t = useTranslations();
  const pathname = usePathname();
  const hit = matchNavItem(pathname);
  const rest = hit ? pathname.slice(hit.item.href === '/' ? 1 : hit.item.href.length).split('/').filter(Boolean) : [];
  const crumbs: { label: string; href?: string }[] = [];
  if (hit && hit.group.key !== 'home') crumbs.push({ label: t(hit.group.labelKey) });
  if (hit) crumbs.push({ label: t(hit.item.labelKey), href: rest.length ? hit.item.href : undefined });
  rest.forEach((s, i) => crumbs.push({
    label: safeDecode(s),
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
