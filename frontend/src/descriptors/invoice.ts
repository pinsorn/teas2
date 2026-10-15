import type { DocDescriptor } from '@/domain/descriptors';

/** Non-VAT company only: the invoice that a VAT company replaces with a tax invoice. L-class: a revision reverses and reposts the journal. */
export const invoice: DocDescriptor = {
  type: 'IV', correctionClass: 'L', vat: 'non-vat-only', titleTh: 'ใบแจ้งหนี้', titleEn: 'Invoice', partyKind: 'customer',
  lineEditor: 'item', basePath: '/sales/invoices',
  permissions: { read: 'doc.IV.read', create: 'doc.IV.create', issue: 'doc.IV.issue', cancel: 'doc.IV.cancel', correct: 'doc.IV.correct' },
  convertsTo: ['BL'], // 'RC' joins with the receipt task (S4): it settles against an open item, not by taking quantities
  listColumns: ['number', 'date', 'party', 'total', 'outstanding', 'status'],
  savedViews: ['draft', 'outstanding', 'overdue', 'cancelled'], headerFields: ['documentDate', 'dueDate', 'reference', 'notes'],
};
