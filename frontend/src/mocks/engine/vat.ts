import type { DocLine, DocTotals, TaxCode } from '@/domain/types';
import { bahtText } from './bahtText';
import { divRoundHalfAway, fromSatang, mulQtyPrice, toSatang } from './money';

export const RATE_BP: Record<TaxCode, bigint> = { S7: 700n, Z0: 0n, EX: 0n };

export interface LineResult { id: string; gross: number; discount: number; net: number; vat: number; total: number }

export function computeLine(l: DocLine, priceIncludesVat: boolean): LineResult {
  const gross = mulQtyPrice(l.qty, toSatang(l.unitPrice));
  const pctBp = l.discountPct ? BigInt(Math.round(Number(l.discountPct) * 100)) : 0n; // 12.5 % -> 1250
  const discount = divRoundHalfAway(gross * pctBp, 10000n);
  const after = gross - discount;
  const bp = RATE_BP[l.taxCode];
  let net: bigint, vat: bigint;
  if (priceIncludesVat) { vat = divRoundHalfAway(after * bp, 10000n + bp); net = after - vat; }
  else { net = after; vat = divRoundHalfAway(net * bp, 10000n); }
  if (l.vatOverride !== undefined) vat = BigInt(toSatang(l.vatOverride)); // correction CN / DN: the engine-set VAT change of this tax code
  const n = (x: bigint) => { const v = Number(x); if (!Number.isSafeInteger(v)) throw new Error('amount too large'); return v; };
  return { id: l.id, gross: n(gross), discount: n(discount), net: n(net), vat: n(vat), total: n(net + vat) };
}

export function computeDoc(lines: DocLine[], priceIncludesVat: boolean) {
  const rs = lines.map((l) => computeLine(l, priceIncludesVat));
  const sum = (k: keyof Omit<LineResult, 'id'>) => rs.reduce((a, r) => a + r[k], 0);
  const totals: DocTotals = {
    gross: fromSatang(sum('gross')), discount: fromSatang(sum('discount')), net: fromSatang(sum('net')),
    vat: fromSatang(sum('vat')), total: fromSatang(sum('total')), amountInWords: bahtText(fromSatang(sum('total'))),
  };
  return { lines: rs.map((r) => ({ id: r.id, net: fromSatang(r.net), vat: fromSatang(r.vat), total: fromSatang(r.total) })), totals };
}
