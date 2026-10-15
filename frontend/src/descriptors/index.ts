import type { DocType } from '@/domain/types';
import { routesOf, type DocDescriptor } from '@/domain/descriptors';
import { NAV } from '@/app-shell/nav';
import { isTypeAvailable } from '@/domain/doc-types';
import { billingStatement } from './billing-statement';
import { creditNote } from './credit-note';
import { debitNote } from './debit-note';
import { deliveryOrder } from './delivery-order';
import { invoice } from './invoice';
import { quotation } from './quotation';
import { receipt } from './receipt';
import { salesOrder } from './sales-order';
import { taxInvoice } from './tax-invoice';

export const DESCRIPTORS: Partial<Record<DocType, DocDescriptor>> = { TI: taxInvoice, QT: quotation, SO: salesOrder, DO: deliveryOrder, IV: invoice, BL: billingStatement, RC: receipt, CN: creditNote, DN: debitNote };
export function descriptorByPath(path: string): DocDescriptor | undefined {
  return Object.values(DESCRIPTORS).find((d) => d.basePath === path);
}
export function docListHref(type: DocType, vatRegistered: boolean): string | undefined {
  const d = DESCRIPTORS[type];
  return d && isTypeAvailable(type, vatRegistered) ? d.basePath : undefined;
}
export function docViewHref(type: DocType, id: string): string | undefined {
  const d = DESCRIPTORS[type];
  return d ? routesOf(d).view(id) : undefined;
}
/** Edit route of a document. A type whose own screens are not built yet still has its nav route (a conversion lands there). */
export function docEditHref(type: DocType, id: string): string | undefined {
  const d = DESCRIPTORS[type];
  if (d) return routesOf(d).edit(id);
  const nav = NAV.flatMap((g) => g.items).find((i) => i.permission === `doc.${type}.read`);
  return nav ? `${nav.href}/${id}/edit` : undefined;
}
