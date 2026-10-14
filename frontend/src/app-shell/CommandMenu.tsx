'use client';
import { useQuery } from '@tanstack/react-query';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Command, CommandDialog, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { DESCRIPTORS } from '@/descriptors';
import { routesOf } from '@/domain/descriptors';
import { isTypeAvailable } from '@/domain/doc-types';
import { endpoints } from '@/lib/api/endpoints';
import { useMe } from './useMe';

export function CommandMenu({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const { me, groups } = useMe();
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); onOpenChange(!open); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onOpenChange]);

  useEffect(() => {
    const id = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(id);
  }, [q]);

  const search = useQuery({
    queryKey: [me?.activeCompanyId, 'search', debounced],
    queryFn: () => endpoints.search(debounced),
    enabled: open && !!me && debounced.length > 0,
  });

  const go = (href: string) => { onOpenChange(false); setQ(''); router.push(href); };
  const needle = q.trim().toLowerCase();
  const pages = groups.flatMap((g) => g.items).filter((i) => t(i.labelKey).toLowerCase().includes(needle));
  const creates = Object.values(DESCRIPTORS).filter((d) => me?.permissions.includes(d.permissions.create)
    && isTypeAvailable(d.type, me.vatRegistered)
    && (locale === 'en' ? d.titleEn : d.titleTh).toLowerCase().includes(needle));
  const hits = (search.data?.items ?? []).filter((h) => h.kind !== 'page');
  // "No results" only once the search for the current term succeeded: never during the debounce, while fetching, or after an error.
  const searched = needle === '' || (debounced === q.trim() && search.isSuccess && !search.isFetching);
  const showEmpty = !creates.length && !pages.length && !hits.length && searched;

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} title={t('command.title')} description={t('command.description')}>
      <Command shouldFilter={false}>{/* every group is already filtered: pages / creates here by `needle`, hits by the server */}
        <CommandInput value={q} onValueChange={setQ} placeholder={t('command.placeholder')} />
        <CommandList>
          {creates.length > 0 && (
            <CommandGroup heading={t('command.create')}>
              {creates.map((d) => (
                <CommandItem key={d.type} value={t('command.createDoc', { title: locale === 'en' ? d.titleEn : d.titleTh })} onSelect={() => go(routesOf(d).create)}>
                  {t('command.createDoc', { title: locale === 'en' ? d.titleEn : d.titleTh })}
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          {pages.length > 0 && (
            <CommandGroup heading={t('command.goTo')}>
              {pages.map((i) => (
                <CommandItem key={i.key} value={t(i.labelKey)} onSelect={() => go(i.href)}>{t(i.labelKey)}</CommandItem>
              ))}
            </CommandGroup>
          )}
          {hits.length > 0 && (
            <CommandGroup heading={t('command.documents')}>
              {hits.map((h) => (
                <CommandItem key={`${h.kind}-${h.id}`} value={h.label} disabled={!h.href} onSelect={() => h.href && go(h.href)}>{h.label}</CommandItem>
              ))}
            </CommandGroup>
          )}
          {search.isFetching && <div role="status" className="px-3 py-1.5 text-sm text-muted-foreground">{t('command.searching')}</div>}
          {search.isError && <div role="alert" className="px-3 py-1.5 text-sm text-destructive">{t('command.searchError')}</div>}
          {showEmpty && <div role="status" className="py-6 text-center text-sm">{t('command.empty')}</div>}
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
