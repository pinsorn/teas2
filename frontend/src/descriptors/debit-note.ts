import type { DocDescriptor } from '@/domain/descriptors';

/** VAT company only; the credit note's twin (a debit note is not capped by the invoice). Opened from the invoice ("ออกใบเพิ่มหนี้" on `?adjust=`). */
export const debitNote: DocDescriptor = {
  type: 'DN', correctionClass: 'T', vat: 'vat-only', titleTh: 'ใบเพิ่มหนี้', titleEn: 'Debit note', partyKind: 'customer',
  lineEditor: 'item', adjusts: 'TI', basePath: '/sales/debit-notes',
  permissions: { read: 'doc.DN.read', create: 'doc.DN.create', issue: 'doc.DN.issue', cancel: 'doc.DN.cancel', correct: 'doc.DN.correct' },
  listColumns: ['number', 'date', 'party', 'total', 'reference', 'status'],
  savedViews: ['draft', 'cancelled'], headerFields: ['documentDate', 'refDoc', 'reason', 'notes'],
};
