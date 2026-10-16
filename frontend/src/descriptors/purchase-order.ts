import type { DocDescriptor } from '@/domain/descriptors';

export const purchaseOrder: DocDescriptor = {
  type: 'PO', correctionClass: 'N', vat: 'both', titleTh: 'ใบสั่งซื้อ', titleEn: 'Purchase order', partyKind: 'vendor',
  lineEditor: 'item', basePath: '/purchases/purchase-orders',
  permissions: { read: 'doc.PO.read', create: 'doc.PO.create', issue: 'doc.PO.issue', cancel: 'doc.PO.cancel', correct: 'doc.PO.correct' },
  convertsTo: ['PB', 'PV'], listColumns: ['number', 'date', 'party', 'total', 'progress', 'status', 'marks'],
  savedViews: ['draft', 'cancelled'], headerFields: ['documentDate', 'dueDate', 'reference', 'notes'], // dueDate is labelled "กำหนดรับของ" (docEditor.dueDateByType.PO)
};
