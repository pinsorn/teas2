import type { CorrectionClass, DocType } from './types';

export interface DocDescriptor {
  type: DocType;
  correctionClass: CorrectionClass;
  titleTh: string;
  titleEn: string;
  partyKind: 'customer' | 'vendor' | 'employee' | null;
  lineEditor: 'item' | 'amount' | 'account';
  vat: 'vat-only' | 'non-vat-only' | 'both';
  issueLabelTh: string;
  basePath: string; // list route, e.g. '/sales/tax-invoices'
  permissions: { read: string; create: string; issue: string; cancel: string; correct: string };
}

export const routesOf = (d: DocDescriptor) => ({
  list: d.basePath,
  create: `${d.basePath}/new`,
  view: (id: string) => `${d.basePath}/${id}`,
  edit: (id: string) => `${d.basePath}/${id}/edit`,
  print: (id: string) => `/print/${d.type}/${id}`,
});
