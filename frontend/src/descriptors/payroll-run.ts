import type { DocDescriptor } from '@/domain/descriptors';

/** A payroll run (PY1, SP0 §5.7): one row per employee with what is paid and withheld this run. The fourth line editor ('payroll'): the accountant types the pay items (salary, overtime, allowance, bonus, other income, other deduction);
 *  the server computes gross, PIT, SSO, net and the year to date (`[SP-R]` tables) and freezes each slip - employee, tables, year to date - when the run is issued. L-class: a revise regenerates the slips and reposts.
 *  Several runs may fall in one month (a bonus run); a run cannot be revised or cancelled while a later run holds the same employees' year to date. The pay date is the document date (the filing month, I11); the reference is the period label. */
export const payrollRun: DocDescriptor = {
  type: 'PR', correctionClass: 'L', vat: 'both', titleTh: 'รอบเงินเดือน', titleEn: 'Payroll run', partyKind: null,
  lineEditor: 'payroll', basePath: '/payroll/runs',
  permissions: { read: 'doc.PR.read', create: 'doc.PR.create', issue: 'doc.PR.issue', cancel: 'doc.PR.cancel', correct: 'doc.PR.correct' },
  listColumns: ['number', 'date', 'total', 'status'],
  savedViews: ['draft', 'pending', 'cancelled'],
  headerFields: ['documentDate', 'reference', 'bankAccount', 'notes'],
};
