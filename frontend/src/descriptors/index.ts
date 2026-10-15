import type { DocType } from '@/domain/types';
import { routesOf, type DocDescriptor } from '@/domain/descriptors';
import { isTypeAvailable } from '@/domain/doc-types';
import { taxInvoice } from './tax-invoice';

export const DESCRIPTORS: Partial<Record<DocType, DocDescriptor>> = { TI: taxInvoice };
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
