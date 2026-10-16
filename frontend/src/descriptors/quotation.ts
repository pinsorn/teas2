import type { DocDescriptor } from '@/domain/descriptors';

export const quotation: DocDescriptor = {
  type: 'QT', correctionClass: 'N', vat: 'both', titleTh: 'ใบเสนอราคา', titleEn: 'Quotation', partyKind: 'customer',
  lineEditor: 'item', basePath: '/sales/quotations',
  permissions: { read: 'doc.QT.read', create: 'doc.QT.create', issue: 'doc.QT.issue', cancel: 'doc.QT.cancel', correct: 'doc.QT.correct' },
  convertsTo: ['SO', 'TI', 'IV'], listColumns: ['number', 'date', 'party', 'total', 'status', 'marks'],
  savedViews: ['draft', 'cancelled'], headerFields: ['documentDate', 'dueDate', 'reference', 'notes'], // dueDate is labelled "ยืนราคาถึง" for a QT (docEditor.dueDateByType.QT)
};
