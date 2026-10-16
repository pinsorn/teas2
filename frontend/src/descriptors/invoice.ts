import type { DocDescriptor } from '@/domain/descriptors';

/** Non-VAT company only: the invoice that a VAT company replaces with a tax invoice. L-class: a revision reverses and reposts the journal. */
export const invoice: DocDescriptor = {
  type: 'IV', correctionClass: 'L', vat: 'non-vat-only', titleTh: 'ใบแจ้งหนี้', titleEn: 'Invoice', partyKind: 'customer',
  lineEditor: 'item', basePath: '/sales/invoices',
  permissions: { read: 'doc.IV.read', create: 'doc.IV.create', issue: 'doc.IV.issue', cancel: 'doc.IV.cancel', correct: 'doc.IV.correct' },
  convertsTo: ['BL'], // a receipt is never a conversion: "รับชำระ" opens /sales/receipts/new?settle=<id> and allocates against the open item
  listColumns: ['number', 'date', 'party', 'total', 'outstanding', 'status'],
  savedViews: ['draft', 'outstanding', 'overdue', 'cancelled'], headerFields: ['documentDate', 'dueDate', 'reference', 'notes'],
};
