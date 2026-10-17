import type { DocDescriptor } from '@/domain/descriptors';

/** A monthly depreciation run (AC5): one per company-month, consecutive, for a month that has ended. Its rows (asset, amount, accounts) are frozen when it is issued and the entry posts exactly those rows.
 *  Only the latest live run can be revised (recomputed) or cancelled (reversed). */
export const depreciationRun: DocDescriptor = {
  type: 'DP', correctionClass: 'L', vat: 'both', titleTh: 'ค่าเสื่อมราคาประจำงวด', titleEn: 'Depreciation run', partyKind: null,
  lineEditor: 'none', basePath: '/accounting/depreciation-runs',
  permissions: { read: 'doc.DP.read', create: 'doc.DP.create', issue: 'doc.DP.issue', cancel: 'doc.DP.cancel', correct: 'doc.DP.correct' },
  listColumns: ['number', 'date', 'reference', 'total', 'status'],
  savedViews: ['cancelled'],
  headerFields: ['documentDate', 'reference'],
};
