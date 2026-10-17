import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { FilingBox, FilingModel } from '@/domain/filings';
import { formatMoney } from '@/lib/format';
import { cn } from '@/lib/utils';

const TAB = { 'vat-output-register': 'output', 'vat-input-register': 'input' } as const;

/** The boxes of a filing as the server computed them; a box that comes from a register links to it for the same period. Nothing is summed here. A box with a numeric code is a numbered box of the form (ภ.พ.30);
 *  the other forms' boxes are named rows. A `count` box is a number of payees, not baht. */
export function FilingBoxes({ boxes, period }: { boxes: FilingBox[]; period: string }) {
  const t = useTranslations('filing.boxes');
  const coded = boxes.some((b) => /^\d/.test(b.code));
  return (
    <Table aria-label={t('title')}>
      <TableHeader>
        <TableRow>{coded ? <TableHead className="w-16">{t('code')}</TableHead> : null}<TableHead>{t('label')}</TableHead><TableHead className="text-end">{t('amount')}</TableHead><TableHead className="w-28 print:hidden"><span className="sr-only">{t('source')}</span></TableHead></TableRow>
      </TableHeader>
      <TableBody>
        {boxes.map((b) => {
          const tab = b.source ? TAB[b.source.reportKind as keyof typeof TAB] : undefined;
          return (
            <TableRow key={b.code} data-testid={`box-${b.code}`} className={cn('h-(--row-h)', b.code === '11' && 'border-t-2 border-(--color-rule) font-semibold')}>
              {coded ? <TableCell className="tabular-nums">{b.code}</TableCell> : null}
              <TableCell>{b.labelTh}</TableCell>
              <TableCell className="text-end tabular-nums">{b.kind === 'count' ? t('count', { n: b.amount }) : formatMoney(b.amount)}</TableCell>
              <TableCell className="print:hidden">{tab ? <Link href={`/tax/vat?tab=${tab}&period=${period}`} className="text-primary underline underline-offset-2">{t('open')}</Link> : null}</TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

const MONEY = /^-?\d+\.\d{2}$/;
/** The attachment of a ภ.ง.ด. (one row per certificate) or the vouchers behind a ภ.พ.36, exactly as the server froze or computed it; a money-shaped cell is laid out as money. */
export function FilingAttachment({ attachment }: { attachment: NonNullable<FilingModel['attachment']> }) {
  const t = useTranslations('filing.attachment');
  return (
    <div className="grid gap-2" data-testid="filing-attachment">
      <h3 className="font-semibold">{t('title')}</h3>
      <div role="region" aria-label={t('title')} tabIndex={0} className="overflow-x-auto rounded-lg border bg-card [&_[data-slot=table-container]]:overflow-visible"> {/* the one scroller on a phone, keyboard-focusable */}
      <Table aria-label={t('title')}>
        <TableHeader><TableRow>{attachment.columns.map((c) => <TableHead key={c.key}>{c.labelTh}</TableHead>)}</TableRow></TableHeader>
        <TableBody>
          {attachment.rows.map((r, i) => (
            <TableRow key={i} className="h-(--row-h)">
              {attachment.columns.map((c) => <TableCell key={c.key} className={cn(MONEY.test(r[c.key] ?? '') && 'text-end tabular-nums')}>{MONEY.test(r[c.key] ?? '') ? formatMoney(r[c.key]) : r[c.key] ?? ''}</TableCell>)}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      </div>
    </div>
  );
}
