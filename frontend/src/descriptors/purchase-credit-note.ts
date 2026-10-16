import type { DocDescriptor } from '@/domain/descriptors';

/** The vendor's credit note against a purchase bill: the vendor issued it, we record it. L-class. Each line references a line of the bill (the per-line cap); opened from the bill on `?adjust=`. */
export const purchaseCreditNote: DocDescriptor = {
  type: 'PCN', correctionClass: 'L', vat: 'both', titleTh: 'ใบลดหนี้จากผู้ขาย', titleEn: 'Vendor credit note', partyKind: 'vendor',
  lineEditor: 'item', adjusts: 'PB', basePath: '/purchases/vendor-notes',
  permissions: { read: 'doc.PCN.read', create: 'doc.PCN.create', issue: 'doc.PCN.issue', cancel: 'doc.PCN.cancel', correct: 'doc.PCN.correct' },
  listColumns: ['number', 'date', 'party', 'total', 'reference', 'status'],
  savedViews: ['draft', 'cancelled'], headerFields: ['documentDate', 'vendorDocNumber', 'vendorDocDate', 'refDoc', 'reason', 'claimPeriod', 'notes'],
};
