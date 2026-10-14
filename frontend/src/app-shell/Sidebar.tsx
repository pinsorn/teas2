'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { CompanySwitcher } from './CompanySwitcher';
import { matchNavItem } from './nav';
import { useMe } from './useMe';

export function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  const t = useTranslations();
  const pathname = usePathname();
  const { groups, isPending, isError, refetch } = useMe();
  const active = matchNavItem(pathname, groups)?.item.href;

  if (isPending) {
    return (
      <div role="status" className="flex flex-col gap-2 p-3">
        <span className="sr-only">{t('common.loading')}</span>
        {Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="h-7" />)}
      </div>
    );
  }
  if (isError) {
    return (
      <div role="alert" className="flex flex-col items-start gap-2 p-3 text-sm">
        <p>{t('shell.meError')}</p>
        <Button variant="outline" size="sm" onClick={() => refetch()}>{t('common.retry')}</Button>
      </div>
    );
  }
  return (
    <nav aria-label={t('shell.navLabel')} className="flex-1 overflow-y-auto px-3 pb-6">
      {groups.map((g) => (
        <div key={g.key} className="mt-4 first:mt-0">
          {g.key !== 'home' && <h2 className="px-2 pb-1 text-xs font-medium text-muted-foreground">{t(g.labelKey)}</h2>}
          <ul className="flex flex-col gap-px">
            {g.items.map((i) => (
              <li key={i.key}>
                <Link
                  href={i.href}
                  onClick={onNavigate}
                  aria-current={i.href === active ? 'page' : undefined}
                  className={cn(
                    'block rounded-md px-2 py-1.5 text-sm outline-none hover:bg-sidebar-accent',
                    i.href === active && 'bg-sidebar-accent font-medium text-sidebar-accent-foreground',
                  )}
                >
                  {t(i.labelKey)}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}

/** Company switcher on top, grouped navigation below. Shared by the desktop sidebar and the mobile sheet. */
export function SidebarPanel({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <>
      <CompanySwitcher />
      <SidebarNav onNavigate={onNavigate} />
    </>
  );
}

export function Sidebar() {
  return (
    <aside className="sticky top-0 hidden h-dvh w-64 shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground md:flex">
      <SidebarPanel />
    </aside>
  );
}
