import type { DocDescriptor } from '@/domain/descriptors';

export const deliveryOrder: DocDescriptor = {
  type: 'DO', correctionClass: 'N', vat: 'both', titleTh: 'ใบส่งของ', titleEn: 'Delivery order', partyKind: 'customer',
  lineEditor: 'item', basePath: '/sales/delivery-orders',
  permissions: { read: 'doc.DO.read', create: 'doc.DO.create', issue: 'doc.DO.issue', cancel: 'doc.DO.cancel', correct: 'doc.DO.correct' },
  convertsTo: ['TI', 'IV'], listColumns: ['number', 'date', 'party', 'total', 'progress', 'status', 'marks'],
  savedViews: ['draft', 'cancelled'], headerFields: ['documentDate', 'reference', 'notes'],
};
