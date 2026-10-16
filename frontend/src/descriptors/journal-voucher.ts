import type { DocDescriptor } from '@/domain/descriptors';

/** A journal voucher (AC1, SP0 §5.2): the accountant's own entry - account lines (one side each, Dr = Cr), no party, no tax. L-class: a revise reverses and reposts. Accounts a document owns (receivable, payable, deposits,
 *  VAT / WHT, bank / cash, fixed assets, opening balances) are refused by the server with the document or screen to use. "กลับรายการ" and the auto-reversing accrual create reversing JVs of their own. */
export const journalVoucher: DocDescriptor = {
  type: 'JV', correctionClass: 'L', vat: 'both', titleTh: 'สมุดรายวันทั่วไป', titleEn: 'Journal voucher', partyKind: null,
  lineEditor: 'account', basePath: '/accounting/journal-vouchers',
  permissions: { read: 'doc.JV.read', create: 'doc.JV.create', issue: 'doc.JV.issue', cancel: 'doc.JV.cancel', correct: 'doc.JV.correct' },
  listColumns: ['number', 'date', 'reference', 'total', 'status'],
  savedViews: ['draft', 'pending', 'cancelled'],
  headerFields: ['documentDate', 'reference', 'autoReverse', 'notes'],
};
