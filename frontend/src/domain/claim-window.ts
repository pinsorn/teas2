import type { IsoDate } from './types';

const monthIndex = (ym: string): number => Number(ym.slice(0, 4)) * 12 + Number(ym.slice(5, 7)) - 1;

/** ม.82/3 [SP-R]: input VAT on a vendor's tax invoice is claimed in the month of the invoice (V) or within the 6 months after it. A bill recorded after that (document month D > V+6)
 *  has already lost the claim: its VAT is cost. `vendorDocDate` empty / absent = the document date. Shared by the engine (which decides) and the editor (which only warns). */
export const inputVatExpired = (documentDate: IsoDate, vendorDocDate?: IsoDate): boolean =>
  monthIndex(documentDate) > monthIndex(vendorDocDate || documentDate) + 6;
