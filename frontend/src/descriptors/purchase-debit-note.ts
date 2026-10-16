import type { DocDescriptor } from '@/domain/descriptors';

/** The vendor's debit note against a purchase bill (a further charge). L-class; opened from the bill on `?adjust=`. */
export const purchaseDebitNote: DocDescriptor = {
  type: 'PDN', correctionClass: 'L', vat: 'both', titleTh: 'ใบเพิ่มหนี้จากผู้ขาย', titleEn: 'Vendor debit note', partyKind: 'vendor',
  lineEditor: 'item', adjusts: 'PB', basePath: '/purchases/vendor-debit-notes',
  permissions: { read: 'doc.PDN.read', create: 'doc.PDN.create', issue: 'doc.PDN.issue', cancel: 'doc.PDN.cancel', correct: 'doc.PDN.correct' },
  listColumns: ['number', 'date', 'party', 'total', 'reference', 'status'],
  savedViews: ['draft', 'cancelled'], headerFields: ['documentDate', 'vendorDocNumber', 'vendorDocDate', 'refDoc', 'reason', 'claimPeriod', 'notes'],
};
