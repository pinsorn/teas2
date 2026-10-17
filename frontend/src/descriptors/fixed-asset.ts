import type { DocDescriptor } from '@/domain/descriptors';

/** The fixed-asset register (AC5, SP0 §5.9): one asset per source line - a bill / voucher capex line or an opening-balance asset row. Registering it posts nothing (its source posted the cost); depreciation runs and the disposal post.
 *  Not edited in the document editor: registered from the register page ("บันทึกเป็นสินทรัพย์"), disposed from its own page. L-class. */
export const fixedAsset: DocDescriptor = {
  type: 'FA', correctionClass: 'L', vat: 'both', titleTh: 'ทะเบียนสินทรัพย์', titleEn: 'Fixed asset', partyKind: 'vendor',
  lineEditor: 'none', basePath: '/accounting/fixed-assets',
  permissions: { read: 'doc.FA.read', create: 'doc.FA.create', issue: 'doc.FA.issue', cancel: 'doc.FA.cancel', correct: 'doc.FA.correct' },
  listColumns: ['number', 'date', 'party', 'total', 'status', 'marks'],
  savedViews: ['cancelled'],
  headerFields: ['documentDate', 'reference', 'notes'],
};
