import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { FilingBox } from '@/domain/filings';
import { formatMoney } from '@/lib/format';
import { cn } from '@/lib/utils';

const TAB = { 'vat-output-register': 'output', 'vat-input-register': 'input' } as const;

/** The boxes of a filing as the server computed them; a box that comes from a register links to it for the same period. Nothing is summed here. */
export function FilingBoxes({ boxes, period }: { boxes: FilingBox[]; period: string }) {
  const t = useTranslations('filing.boxes');
  return (
    <Table aria-label={t('title')}>
      <TableHeader>
        <TableRow><TableHead className="w-16">{t('code')}</TableHead><TableHead>{t('label')}</TableHead><TableHead className="text-end">{t('amount')}</TableHead><TableHead className="w-28 print:hidden"><span className="sr-only">{t('source')}</span></TableHead></TableRow>
      </TableHeader>
      <TableBody>
        {boxes.map((b) => {
          const tab = b.source ? TAB[b.source.reportKind as keyof typeof TAB] : undefined;
          return (
            <TableRow key={b.code} data-testid={`box-${b.code}`} className={cn('h-(--row-h)', b.code === '11' && 'border-t-2 border-(--color-rule) font-semibold')}>
              <TableCell className="tabular-nums">{b.code}</TableCell>
              <TableCell>{b.labelTh}</TableCell>
              <TableCell className="text-end tabular-nums">{formatMoney(b.amount)}</TableCell>
              <TableCell className="print:hidden">{tab ? <Link href={`/tax/vat?tab=${tab}&period=${period}`} className="text-primary underline underline-offset-2">{t('open')}</Link> : null}</TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
