import type { DocDescriptor } from '@/domain/descriptors';

/** VAT company only. T-class: money changes by cancel + a new note; each line references a line of the tax invoice it credits (the per-line cap). Opened from the invoice ("ออกใบลดหนี้" on `?adjust=`). */
export const creditNote: DocDescriptor = {
  type: 'CN', correctionClass: 'T', vat: 'vat-only', titleTh: 'ใบลดหนี้', titleEn: 'Credit note', partyKind: 'customer',
  lineEditor: 'item', adjusts: 'TI', basePath: '/sales/credit-notes',
  permissions: { read: 'doc.CN.read', create: 'doc.CN.create', issue: 'doc.CN.issue', cancel: 'doc.CN.cancel', correct: 'doc.CN.correct' },
  listColumns: ['number', 'date', 'party', 'total', 'reference', 'status'],
  savedViews: ['draft', 'cancelled'], headerFields: ['documentDate', 'refDoc', 'reason', 'notes'],
};
