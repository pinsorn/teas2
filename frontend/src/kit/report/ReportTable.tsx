import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { ReportChip, ReportColumn, ReportRow } from '@/domain/reports';
import { formatDateBE, formatMoney } from '@/lib/format';
import { cn } from '@/lib/utils';

const INDENT = ['', 'ps-4', 'ps-8'];
const CHIP = { finalized: 'secondary', paid: 'secondary', owed: 'destructive', draft: 'outline', na: 'outline' } as const;

/** A status cell (TX3b): one chip per return of the row's typed `chips`, linking to it. */
function Chips({ chips }: { chips: ReportChip[] }) {
  const t = useTranslations();
  return <span className="flex flex-wrap gap-1">{chips.map((c) => {
    const chip = <Badge variant={CHIP[c.state] ?? 'outline'} data-state={c.state}>{c.form ? `${c.form} ` : null}{t(`reports.taxSummary.states.${c.state}` as never)}</Badge>;
    return c.href ? <Link key={`${c.form}:${c.state}`} href={c.href}>{chip}</Link> : <span key={`${c.form}:${c.state}`}>{chip}</span>;
  })}</span>;
}

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
                  {c.kind === 'status' ? <Chips chips={r.chips ?? []} /> : r.href && ci === 0 ? <Link href={r.href} className="text-primary underline underline-offset-2">{text}</Link> : text}
                </TableCell>
              );
            })}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
