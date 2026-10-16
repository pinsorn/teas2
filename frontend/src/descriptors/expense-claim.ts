import type { DocDescriptor } from '@/domain/descriptors';

/** An employee's expense claim (§7.6, D-18): the employee spent their own money, the company owes it to them (2180). L-class. Input VAT only for a line with the vendor's tax invoice behind it
 *  (`mocks/engine/purchase-vat.ts`). Every claim goes through the approval policy before it is issued; it is paid by a payment voucher made from it ("แปลงเป็น…" -> PV), which withholds nothing. */
export const expenseClaim: DocDescriptor = {
  type: 'EX', correctionClass: 'L', vat: 'both', titleTh: 'ใบเบิกค่าใช้จ่าย', titleEn: 'Expense claim', partyKind: 'employee',
  lineEditor: 'amount', convertsTo: ['PV'], basePath: '/purchases/expense-claims',
  permissions: { read: 'doc.EX.read', create: 'doc.EX.create', issue: 'doc.EX.issue', cancel: 'doc.EX.cancel', correct: 'doc.EX.correct' },
  listColumns: ['number', 'date', 'party', 'total', 'outstanding', 'status'],
  savedViews: ['draft', 'pending', 'outstanding', 'cancelled'],
  headerFields: ['documentDate', 'reference', 'notes'],
};
