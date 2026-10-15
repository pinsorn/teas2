import type { DocLine, DocTotals, TaxCode } from '@/domain/types';
import { bahtText } from './bahtText';
import { divRoundHalfAway, fromSatang, mulQtyPrice, toSatang } from './money';

export const RATE_BP: Record<TaxCode, bigint> = { S7: 700n, Z0: 0n, EX: 0n };

export interface LineResult { id: string; gross: number; discount: number; net: number; vat: number; total: number }

/** I1: a company outside VAT charges no VAT on any line, whatever its tax code. */
export const vatOf = (st: { companies: { id: string; vatRegistered: boolean }[] }, companyId: string): boolean => !!st.companies.find((c) => c.id === companyId)?.vatRegistered;

/** `vatRegistered` is required on purpose: every caller states the company's VAT status (I1), none can forget it. */
export function computeLine(l: DocLine, priceIncludesVat: boolean, vatRegistered: boolean): LineResult {
  const gross = mulQtyPrice(l.qty, toSatang(l.unitPrice));
  const pctBp = l.discountPct ? BigInt(Math.round(Number(l.discountPct) * 100)) : 0n; // 12.5 % -> 1250
  const discount = divRoundHalfAway(gross * pctBp, 10000n);
  const after = gross - discount;
  const bp = vatRegistered ? RATE_BP[l.taxCode] : 0n;
  let net: bigint, vat: bigint;
  if (priceIncludesVat) { vat = divRoundHalfAway(after * bp, 10000n + bp); net = after - vat; }
  else { net = after; vat = divRoundHalfAway(net * bp, 10000n); }
  if (l.vatOverride !== undefined && vatRegistered) vat = BigInt(toSatang(l.vatOverride)); // correction CN / DN: the engine-set VAT change of this tax code
  const n = (x: bigint) => { const v = Number(x); if (!Number.isSafeInteger(v)) throw new Error('amount too large'); return v; };
  return { id: l.id, gross: n(gross), discount: n(discount), net: n(net), vat: n(vat), total: n(net + vat) };
}

export function computeDoc(lines: DocLine[], priceIncludesVat: boolean, vatRegistered: boolean) {
  const rs = lines.map((l) => computeLine(l, priceIncludesVat, vatRegistered));
  const sum = (k: keyof Omit<LineResult, 'id'>) => rs.reduce((a, r) => a + r[k], 0);
  const totals: DocTotals = {
    gross: fromSatang(sum('gross')), discount: fromSatang(sum('discount')), net: fromSatang(sum('net')),
    vat: fromSatang(sum('vat')), total: fromSatang(sum('total')), amountInWords: bahtText(fromSatang(sum('total'))),
  };
  return { lines: rs.map((r) => ({ id: r.id, net: fromSatang(r.net), vat: fromSatang(r.vat), total: fromSatang(r.total) })), totals };
}
