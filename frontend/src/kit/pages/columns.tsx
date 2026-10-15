import type { DocDescriptor, ListColumnKey, SavedViewKey } from '@/domain/descriptors';
import type { DocListColumn, SavedView } from '@/kit/doc-list/DocList';
import { MarksChips } from '@/kit/doc-view/MarksChips';
import { StatusChip } from '@/kit/doc-list/StatusChip';
import { formatDateBE, formatTHB } from '@/lib/format';

type Translate = (key: string) => string;
/** The party column names the counterparty: customer for sales, vendor for purchases. */
const partyHeader: Record<string, string> = { customer: 'customer', vendor: 'vendor' };
export function columnsFor(d: DocDescriptor, t: Translate, common: Translate): DocListColumn[] {
  const cells: Record<ListColumnKey, DocListColumn['cell']> = {
    number: (r) => r.number ?? common('draftNoNumber'),
    date: (r) => formatDateBE(r.documentDate),
    party: (r) => r.partyName,
    total: (r) => formatTHB(r.total),
    outstanding: (r) => r.outstanding ? formatTHB(r.outstanding) : common('placeholder'),
    status: (r) => <StatusChip status={r.status} />,
    dueDate: (r) => r.dueDate ? formatDateBE(r.dueDate) : common('placeholder'),
    reference: (r) => r.reference ?? common('placeholder'),
    progress: () => common('placeholder'),
    marks: (r) => r.marks ? <span className="inline-flex flex-wrap gap-1"><MarksChips marks={r.marks} /></span> : common('placeholder'),
  };
  return d.listColumns.map((key) => ({ key, header: t(`columns.${key === 'party' ? partyHeader[d.partyKind ?? ''] ?? 'party' : key}`), cell: cells[key],
    ...(['total', 'outstanding'].includes(key) ? { align: 'end' as const } : {}) }));
}
const PARAMS: Record<SavedViewKey, Record<string, string>> = {
  draft: { status: 'draft' }, pending: { status: 'pending' },
  outstanding: { status: 'issued,partly_settled', outstanding: 'positive' },
  overdue: { status: 'issued,partly_settled', outstanding: 'positive', overdue: '1' },
  cancelled: { status: 'cancelled' }, agent: { agent: '1' },
};
export function savedViewsFor(d: DocDescriptor, t: Translate): SavedView[] {
  return d.savedViews.map((key) => ({ key, label: t(`views.${key}`), params: { ...PARAMS[key] } }));
}
