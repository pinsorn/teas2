'use client';
import { useTranslations } from 'next-intl';
import { Suspense } from 'react';
import { taxInvoice } from '@/descriptors/tax-invoice';
import { DocList, type DocListColumn, type SavedView } from '@/kit/doc-list/DocList';
import { StatusChip } from '@/kit/doc-list/StatusChip';
import { LoadingState } from '@/kit/states/LoadingState';
import { formatDateBE, formatTHB } from '@/lib/format';
import { VatGate } from './gate';

export default function TaxInvoicesPage() {
  const t = useTranslations('taxInvoice');
  const tc = useTranslations('common');
  const columns: DocListColumn[] = [
    { key: 'number', header: t('columns.number'), cell: (r) => r.number ?? tc('draftNoNumber') },
    { key: 'date', header: t('columns.date'), cell: (r) => formatDateBE(r.documentDate) },
    { key: 'party', header: t('columns.customer'), cell: (r) => r.partyName },
    { key: 'total', header: t('columns.total'), align: 'end', cell: (r) => formatTHB(r.total) },
    { key: 'outstanding', header: t('columns.outstanding'), align: 'end', cell: (r) => (r.outstanding ? formatTHB(r.outstanding) : '-') },
    { key: 'status', header: t('columns.status'), cell: (r) => <StatusChip status={r.status} /> },
  ];
  const savedViews: SavedView[] = [
    { key: 'draft', label: t('views.draft'), params: { status: 'draft' } },
    { key: 'outstanding', label: t('views.outstanding'), params: { status: 'issued' } },
    { key: 'overdue', label: t('views.overdue'), params: { status: 'issued', overdue: '1' } },
    { key: 'cancelled', label: t('views.cancelled'), params: { status: 'cancelled' } },
  ];
  return (
    <VatGate>
      <Suspense fallback={<LoadingState />}>
        <DocList descriptor={taxInvoice} columns={columns} savedViews={savedViews} bulkActions={[]} />
      </Suspense>
    </VatGate>
  );
}
