'use client';
import { useTranslations } from 'next-intl';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { JournalPreview } from '@/domain/types';
import { formatMoney } from '@/lib/format';

/** The journal entry the server would post, shown before issuing. */
export function JournalDrawer({ open, onOpenChange, journal }: { open: boolean; onOpenChange: (o: boolean) => void; journal?: JournalPreview }) {
  const t = useTranslations('docEditor');
  const entries = journal?.entries ?? [];
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="overflow-y-auto data-[side=right]:sm:max-w-xl">
        <SheetHeader><SheetTitle>{t('journalTitle')}</SheetTitle><SheetDescription>{t('journalBody')}</SheetDescription></SheetHeader>
        <div className="grid gap-4 px-4 pb-4">
          {entries.length === 0 ? <p className="text-body text-muted-foreground">{t('journalEmpty')}</p> : entries.map((e, k) => (
            <Table key={k}>
              <TableHeader><TableRow>
                <TableHead>{t('account')}</TableHead><TableHead className="text-right">{t('debit')}</TableHead><TableHead className="text-right">{t('credit')}</TableHead>
              </TableRow></TableHeader>
              <TableBody>
                {e.lines.map((l, i) => (
                  <TableRow key={i}>
                    <TableCell>{l.accountCode} {l.accountName}</TableCell>
                    <TableCell className="text-right tabular-nums">{/[1-9]/.test(l.debit) ? formatMoney(l.debit) : ''}</TableCell>
                    <TableCell className="text-right tabular-nums">{/[1-9]/.test(l.credit) ? formatMoney(l.credit) : ''}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ))}
        </div>
      </SheetContent>
    </Sheet>
  );
}
