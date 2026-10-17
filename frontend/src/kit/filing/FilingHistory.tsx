import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { FilingHistoryItem } from '@/domain/filings';
import { formatDateBE, formatMoney } from '@/lib/format';
import { monthBE } from '../close/PeriodGrid';

/** The filings already finalized, newest first; each month opens its frozen snapshot. */
export function FilingHistory({ items }: { items: FilingHistoryItem[] }) {
  const t = useTranslations('filing.history');
  return (
    <section aria-label={t('title')} className="grid gap-2" data-testid="filing-history">
      <h2 className="text-section font-semibold">{t('title')}</h2>
      {items.length === 0 ? <p className="text-muted-foreground">{t('empty')}</p> : (
        <Table aria-label={t('title')}>
          <TableHeader><TableRow><TableHead>{t('period')}</TableHead><TableHead>{t('at')}</TableHead><TableHead>{t('by')}</TableHead><TableHead className="text-end">{t('net')}</TableHead></TableRow></TableHeader>
          <TableBody>
            {items.map((h) => (
              <TableRow key={`${h.form}-${h.period}`} className="h-(--row-h)">
                <TableCell><Link href={h.form === 'PP30' ? `/tax/vat?period=${h.period}` : `/tax/wht?tab=${h.form.toLowerCase()}&period=${h.period}`} className="text-primary underline underline-offset-2">{monthBE(h.period)}</Link></TableCell>
                <TableCell>{formatDateBE(h.finalizedAt.slice(0, 10))}</TableCell>
                <TableCell>{h.finalizedBy}</TableCell>
                <TableCell className="text-end tabular-nums">{formatMoney(h.net)} <span className="text-small text-muted-foreground">{h.overpaid ? t('overpaid') : t('payable')}</span></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}
