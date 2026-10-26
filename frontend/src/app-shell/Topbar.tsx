'use client';
import { LanguagesIcon, MenuIcon, SearchIcon, UserIcon } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { SessionExpiryDialog } from '@/kit/auth/SessionExpiryDialog';
import { setLocale } from '@/records/auth';
import { Breadcrumbs } from './Breadcrumbs';
import { CommandMenu } from './CommandMenu';
import { SidebarPanel } from './Sidebar';

export function Topbar() {
  const t = useTranslations('shell');
  const locale = useLocale();
  const router = useRouter();
  const [menu, setMenu] = useState(false);
  const [command, setCommand] = useState(false);
  return (
    <header className="sticky top-0 z-30 flex h-12 items-center gap-2 border-b bg-background px-3 md:px-6">
      <Button variant="ghost" size="icon" className="md:hidden" aria-label={t('openMenu')} onClick={() => setMenu(true)}>
        <MenuIcon aria-hidden />
      </Button>
      <Sheet open={menu} onOpenChange={setMenu}>
        <SheetContent side="left" className="w-72 gap-0 p-0">
          <SheetHeader className="sr-only">
            <SheetTitle>{t('menuTitle')}</SheetTitle>
            <SheetDescription>{t('navLabel')}</SheetDescription>
          </SheetHeader>
          <SidebarPanel onNavigate={() => setMenu(false)} />
        </SheetContent>
      </Sheet>
      <div className="min-w-0 flex-1"><Breadcrumbs /></div>
      <Button variant="outline" className="gap-2 text-muted-foreground" onClick={() => setCommand(true)}>
        <SearchIcon aria-hidden />
        <span className="hidden sm:inline">{t('search')}</span>
        <span className="sm:hidden">{t('searchShort')}</span>
        <kbd className="hidden rounded border bg-muted px-1 text-xs sm:inline">{t('searchHint')}</kbd>
      </Button>
      <Button variant="ghost" size="icon" aria-label={t(locale === 'en' ? 'switchToThai' : 'switchToEnglish')} onClick={() => { setLocale(locale === 'en' ? 'th' : 'en'); router.refresh(); }}>
        <LanguagesIcon aria-hidden />
      </Button>
      <Button variant="ghost" size="icon" asChild><Link href="/profile" aria-label={t('profile')}><UserIcon aria-hidden /></Link></Button>
      <CommandMenu open={command} onOpenChange={setCommand} />
      <SessionExpiryDialog />
    </header>
  );
}
