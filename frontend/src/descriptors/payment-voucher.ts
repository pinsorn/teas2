import type { DocDescriptor } from '@/domain/descriptors';

/** Pays vendors: settles open bills (PB) and expense claims (EX) by allocation, plus its own expense lines (no tax invoice: input VAT only through a bill, D-16). WHT is withheld per WHT type from
 *  those lines and from the typed lines of the bills paid; each type issues a 50 ทวิ (WT) in the same command. L-class: a revision reverses and reposts the journal and re-issues changed certificates. */
export const paymentVoucher: DocDescriptor = {
  type: 'PV', correctionClass: 'L', vat: 'both', titleTh: 'ใบสำคัญจ่าย', titleEn: 'Payment voucher', partyKind: 'vendor',
  lineEditor: 'amount', settles: ['PB', 'EX'], basePath: '/purchases/payment-vouchers',
  permissions: { read: 'doc.PV.read', create: 'doc.PV.create', issue: 'doc.PV.issue', cancel: 'doc.PV.cancel', correct: 'doc.PV.correct' },
  listColumns: ['number', 'date', 'party', 'total', 'status'],
  savedViews: ['draft', 'pending', 'cancelled'],
  headerFields: ['documentDate', 'bankAccount', 'paymentMethod', 'cheque', 'whtMode', 'reference', 'notes'],
};
