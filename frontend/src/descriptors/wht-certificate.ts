import type { DocDescriptor } from '@/domain/descriptors';

/** The 50 ทวิ: written by the system when a payment voucher is issued (one per WHT type), cancelled with / by its voucher. Nobody creates, issues, cancels or corrects one by hand - only `read` is granted
 *  to a role; the other four permission codes exist on the descriptor but not in the catalog, so the action bar offers print and nothing else. T-class: frozen at the first print (I7). */
export const whtCertificate: DocDescriptor = {
  type: 'WT', correctionClass: 'T', vat: 'both', titleTh: 'หนังสือรับรองการหักภาษี ณ ที่จ่าย', titleEn: 'Withholding tax certificate', partyKind: 'vendor',
  lineEditor: 'none', basePath: '/tax/wht-certificates',
  permissions: { read: 'doc.WT.read', create: 'doc.WT.create', issue: 'doc.WT.issue', cancel: 'doc.WT.cancel', correct: 'doc.WT.correct' },
  listColumns: ['number', 'date', 'party', 'whtForm', 'whtIncome', 'whtTax', 'status'],
  savedViews: ['pnd3', 'pnd53', 'pnd2', 'pnd54', 'cancelled'],
  headerFields: [],
};
