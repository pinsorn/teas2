import type { DocDescriptor } from '@/domain/descriptors';

/** Settles open TI / IV of one customer (D-12), or - non-VAT company only - sells over the counter as a cash bill. T-class: money changes by cancel + reissue; only the withholding certificate number is a free in-place edit. */
export const receipt: DocDescriptor = {
  type: 'RC', correctionClass: 'T', vat: 'both', titleTh: 'ใบเสร็จรับเงิน', titleEn: 'Receipt', partyKind: 'customer',
  lineEditor: 'amount', linesWhen: 'non-vat', settles: ['TI', 'IV'], basePath: '/sales/receipts',
  permissions: { read: 'doc.RC.read', create: 'doc.RC.create', issue: 'doc.RC.issue', cancel: 'doc.RC.cancel', correct: 'doc.RC.correct' },
  listColumns: ['number', 'date', 'party', 'total', 'status'],
  savedViews: ['draft', 'cancelled'], headerFields: ['documentDate', 'bankAccount', 'paymentMethod', 'cheque', 'reference', 'notes'],
};
