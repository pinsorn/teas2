import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { ReportColumn, ReportRow } from '@/domain/reports';
import { formatDateBE, formatMoney } from '@/lib/format';
import { cn } from '@/lib/utils';

const INDENT = ['', 'ps-4', 'ps-8'];

/** Lays out a server-computed model. Every figure arrives as a string; nothing is summed or rounded here. */
export function ReportTable({ title, columns, rows }: { title: string; columns: ReportColumn[]; rows: ReportRow[] }) {
  const t = useTranslations();
  const labelCol = columns.findIndex((c) => !c.kind || c.kind === 'text'); // a total / subtotal row names itself here
  const show = (c: ReportColumn, v: string) => (!v ? '' : c.kind === 'money' ? formatMoney(v) : c.kind === 'date' ? formatDateBE(v) : v);
  return (
    <Table aria-label={title}>
      <TableHeader>
        <TableRow>
          {columns.map((c) => <TableHead key={c.key} className={cn(c.align === 'end' && 'text-end')}>{t(c.labelKey as never)}</TableHead>)}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r, i) => (
          <TableRow key={i} className={cn('h-(--row-h)', r.kind !== 'row' && 'font-semibold', r.kind === 'total' && 'border-t-2 border-(--color-rule)')}>
            {columns.map((c, ci) => {
              const text = !r.cells[c.key] && ci === labelCol && (r.kind === 'total' || r.kind === 'subtotal') ? t('reports.total') : show(c, r.cells[c.key] ?? '');
              return (
                <TableCell key={c.key} className={cn(c.align === 'end' && 'text-end tabular-nums', ci === 0 && INDENT[r.level])}>
                  {r.href && ci === 0 ? <Link href={r.href} className="text-primary underline underline-offset-2">{text}</Link> : text}
                </TableCell>
              );
            })}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
