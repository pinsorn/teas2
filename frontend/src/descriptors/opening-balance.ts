import type { DocDescriptor } from '@/domain/descriptors';

/** Opening balances (AC3, SP0 §5.10): the batch that defines where the books start. A wizard (trial balance, open items, assets, payroll year-to-date, bank, check) instead of the document editor; the account lines are its trial-balance step.
 *  L-class: a revise reverses and reposts at the cut-off. Its open items and in-transit bank items are frozen, settleable rows (OB items); the 3900 account takes the imbalance. */
export const openingBalance: DocDescriptor = {
  type: 'OB', correctionClass: 'L', vat: 'both', titleTh: 'ยอดยกมา', titleEn: 'Opening balances', partyKind: null,
  lineEditor: 'account', basePath: '/accounting/opening-balances',
  permissions: { read: 'doc.OB.read', create: 'doc.OB.create', issue: 'doc.OB.issue', cancel: 'doc.OB.cancel', correct: 'doc.OB.correct' },
  listColumns: ['number', 'date', 'total', 'status'],
  savedViews: ['draft'],
  headerFields: ['documentDate', 'notes'],
};
