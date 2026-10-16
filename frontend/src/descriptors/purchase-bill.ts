import type { DocDescriptor } from '@/domain/descriptors';

/** A vendor's tax invoice / expense bill, recorded (not issued) by us. L-class: a revision reverses and reposts the journal. Input VAT rules: `mocks/engine/purchase-vat.ts` (ม.82/3, ม.82/5).
 *  No generic "convert to…": the credit / debit notes are made from the bill ("บันทึกใบลดหนี้/เพิ่มหนี้จากผู้ขาย" on `?adjust=`), the payment voucher from open items (P3). */
export const purchaseBill: DocDescriptor = {
  type: 'PB', correctionClass: 'L', vat: 'both', titleTh: 'บันทึกซื้อ/ค่าใช้จ่าย', titleEn: 'Purchase bill', partyKind: 'vendor',
  lineEditor: 'amount', basePath: '/purchases/bills',
  permissions: { read: 'doc.PB.read', create: 'doc.PB.create', issue: 'doc.PB.issue', cancel: 'doc.PB.cancel', correct: 'doc.PB.correct' },
  listColumns: ['number', 'date', 'party', 'reference', 'total', 'outstanding', 'status'],
  savedViews: ['draft', 'outstanding', 'overdue', 'cancelled'],
  headerFields: ['documentDate', 'vendorDocNumber', 'vendorDocDate', 'claimPeriod', 'dueDate', 'complete', 'notes'],
};
