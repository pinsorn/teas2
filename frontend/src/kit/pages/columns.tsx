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
    progress: (r) => r.progress ?? common('placeholder'),
    whtForm: (r) => (r.wht ? t(`whtForms.${r.wht.form}`) : common('placeholder')),
    whtIncome: (r) => (r.wht ? formatTHB(r.wht.income) : common('placeholder')),
    whtTax: (r) => (r.wht ? formatTHB(r.wht.tax) : common('placeholder')),
    marks: (r) => r.marks ? <span className="inline-flex flex-wrap gap-1"><MarksChips marks={r.marks} /></span> : common('placeholder'),
  };
  return d.listColumns.map((key) => ({ key, header: t(`columns.${key === 'party' ? (d.type === 'WT' ? 'payee' : partyHeader[d.partyKind ?? ''] ?? 'party') : key}`), cell: cells[key],
    ...(['total', 'outstanding', 'whtIncome', 'whtTax'].includes(key) ? { align: 'end' as const } : {}) }));
}
const PARAMS: Record<SavedViewKey, Record<string, string>> = {
  draft: { status: 'draft' }, pending: { status: 'pending' },
  outstanding: { status: 'issued,partly_settled', outstanding: 'positive' },
  overdue: { status: 'issued,partly_settled', outstanding: 'positive', overdue: '1' },
  cancelled: { status: 'cancelled' }, agent: { agent: '1' },
  pnd3: { form: 'PND3' }, pnd53: { form: 'PND53' }, pnd2: { form: 'PND2' }, pnd54: { form: 'PND54' },
};
export function savedViewsFor(d: DocDescriptor, t: Translate): SavedView[] {
  const keys: SavedViewKey[] = d.savedViews.includes('agent') ? d.savedViews : [...d.savedViews, 'agent']; // "created by an AI agent" exists for every document type
  return keys.map((key) => ({ key, label: t(`views.${key}`), params: { ...PARAMS[key] } }));
}
