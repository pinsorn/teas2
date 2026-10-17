import type { CorrectionClass, DocType } from './types';
import type { VatScope } from './doc-types';

export type LineEditorKind = 'item' | 'amount' | 'account' | 'payroll' | 'none';
export type ListColumnKey = 'number' | 'date' | 'party' | 'total' | 'outstanding' | 'status' | 'dueDate' | 'reference' | 'progress' | 'marks' | 'whtForm' | 'whtIncome' | 'whtTax';
export type SavedViewKey = 'draft' | 'pending' | 'outstanding' | 'overdue' | 'cancelled' | 'agent' | 'pnd3' | 'pnd53' | 'pnd2' | 'pnd54';
export type HeaderFieldKey = 'documentDate' | 'dueDate' | 'reference' | 'notes' | 'bankAccount' | 'paymentMethod'
  | 'cheque' | 'whtMode' | 'claimPeriod' | 'vendorDocNumber' | 'vendorDocDate' | 'reason' | 'refDoc' | 'autoReverse' | 'complete';
export interface DocDescriptor {
  type: DocType;
  correctionClass: CorrectionClass;           // must equal DOC_TYPES[type].class (contract test)
  vat: VatScope;                              // must equal DOC_TYPES[type].vat (contract test)
  titleTh: string; titleEn: string;
  partyKind: 'customer' | 'vendor' | 'employee' | null;
  lineEditor: LineEditorKind;
  linesWhen?: 'non-vat';                      // RC: line grid only for a non-VAT company (D-12)
  basePath: string;                           // two segments: '/<group>/<slug>'
  permissions: { read: string; create: string; issue: string; cancel: string; correct: string };
  convertsTo?: DocType[];                     // subset of CONVERSIONS[type]
  settles?: DocType[];                        // F5: open-item types this document allocates to
  groups?: DocType[];                         // BL: types it groups
  adjusts?: DocType;                          // CN/DN → TI, PCN/PDN → PB
  listColumns: ListColumnKey[];
  savedViews: SavedViewKey[];
  headerFields: HeaderFieldKey[];
}
export const routesOf = (d: DocDescriptor) => ({
  list: d.basePath,
  create: `${d.basePath}/new`,
  view: (id: string) => `${d.basePath}/${id}`,
  edit: (id: string) => `${d.basePath}/${id}/edit`,
  print: (id: string) => `/print/${d.type}/${id}`,
});
