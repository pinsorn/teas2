'use client';
import { useTranslations } from 'next-intl';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { Doc } from '@/domain/types';
import { formatDateBE, formatMoney } from '@/lib/format';

/** What an approver is asked to approve: a document that is not issued has no paper yet, so its lines are listed as typed (text only - the server owns every total shown in the header). */
export function DocLinesPreview({ doc }: { doc: Doc }) {
  const t = useTranslations('docView.linesPreview');
  const tx = useTranslations('docEditor.lines.taxCode');
  const tcat = useTranslations('records.options.expenseCategory');
  return (
    <section aria-label={t('title')} className="overflow-x-auto rounded-lg border bg-card" data-testid="lines-preview">
      <Table>
        <TableHeader><TableRow>
          <TableHead>{t('description')}</TableHead><TableHead>{t('category')}</TableHead><TableHead className="text-right">{t('amount')}</TableHead><TableHead>{t('tax')}</TableHead><TableHead>{t('invoice')}</TableHead>
        </TableRow></TableHeader>
        <TableBody>
          {doc.lines.map((l) => (
            <TableRow key={l.id}>
              <TableCell className="whitespace-normal">{l.description}</TableCell>
              <TableCell>{l.expenseCategory ? tcat(l.expenseCategory) : ''}</TableCell>
              <TableCell className="text-right tabular-nums">{l.qty === '1' ? '' : `${l.qty} × `}{formatMoney(l.unitPrice)}</TableCell>
              <TableCell>{tx(l.taxCode)}</TableCell>
              <TableCell className="whitespace-normal">{l.vendorInvoice ? `${l.vendorInvoice.number} · ${l.vendorInvoice.vendorName} · ${formatDateBE(l.vendorInvoice.date)}` : l.taxCode === 'S7' ? t('noInvoice') : ''}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </section>
  );
}
