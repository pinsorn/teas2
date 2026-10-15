import type { DocDescriptor } from '@/domain/descriptors';

/** Groups the open TI / IV of one customer for collection. No lines, no ledger: its content is the grouped list and the server-summed total. */
export const billingStatement: DocDescriptor = {
  type: 'BL', correctionClass: 'N', vat: 'both', titleTh: 'ใบวางบิล', titleEn: 'Billing statement', partyKind: 'customer',
  lineEditor: 'none', groups: ['TI', 'IV'], basePath: '/sales/billing-statements',
  permissions: { read: 'doc.BL.read', create: 'doc.BL.create', issue: 'doc.BL.issue', cancel: 'doc.BL.cancel', correct: 'doc.BL.correct' },
  listColumns: ['number', 'date', 'party', 'total', 'dueDate', 'status'],
  savedViews: ['draft', 'cancelled'], headerFields: ['documentDate', 'dueDate', 'notes'],
};
