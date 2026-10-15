import type { DocDescriptor } from '@/domain/descriptors';

export const salesOrder: DocDescriptor = {
  type: 'SO', correctionClass: 'N', vat: 'both', titleTh: 'ใบสั่งขาย', titleEn: 'Sales order', partyKind: 'customer',
  lineEditor: 'item', basePath: '/sales/sales-orders',
  permissions: { read: 'doc.SO.read', create: 'doc.SO.create', issue: 'doc.SO.issue', cancel: 'doc.SO.cancel', correct: 'doc.SO.correct' },
  convertsTo: ['DO', 'TI', 'IV'], listColumns: ['number', 'date', 'party', 'total', 'progress', 'status', 'marks'],
  savedViews: ['draft', 'cancelled'], headerFields: ['documentDate', 'dueDate', 'reference', 'notes'], // dueDate is labelled "กำหนดส่ง" (docEditor.dueDateByType.SO)
};
