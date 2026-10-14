import type { DocDescriptor } from '@/domain/descriptors';

export const taxInvoice: DocDescriptor = {
  type: 'TI', correctionClass: 'T', titleTh: 'ใบกำกับภาษี', titleEn: 'Tax invoice',
  partyKind: 'customer', lineEditor: 'item', vat: 'vat-only', issueLabelTh: 'บันทึกและออกใบกำกับภาษี',
  basePath: '/sales/tax-invoices',
  permissions: { read: 'doc.TI.read', create: 'doc.TI.create', issue: 'doc.TI.issue', cancel: 'doc.TI.cancel', correct: 'doc.TI.correct' },
};
