import type { IsoDate, PartySummary, WhtLine, WhtMode } from '@/domain/types';
import type { MockState } from '../store';
import { MockError } from './log';
import { divRoundHalfAway, fromSatang } from './money';

/** Mock WHT reference data. Every rate is a `[SP-R]` fixture (fixtures/wht-types.ts), never "the rule". */
export interface WhtType { code: string; nameTh: string; rateBp: number; incomeType: string; pnd2?: boolean; pnd54?: boolean; effectiveFrom: IsoDate }

/** The return the payee's tax falls on: pnd54 -> PND54; pnd2 && individual -> PND2; individual -> PND3; else PND53. */
export function formFor(t: WhtType, payee: PartySummary): WhtLine['form'] {
  if (t.pnd54) return 'PND54';
  if (payee.entityKind === 'individual') return t.pnd2 ? 'PND2' : 'PND3';
  return 'PND53';
}

const BP = 10000n;
const rateText = (bp: number) => `${bp % 100 === 0 ? bp / 100 : (bp / 100).toFixed(2)}%`;

/** The type in force on `date` for the payee's company (the payee id is unique per company), latest `effectiveFrom` wins. */
export function whtTypeOf(st: MockState, code: string, payee: PartySummary, date: IsoDate): WhtType {
  const companyId = st.parties.find((p) => p.id === payee.id)?.companyId;
  const hit = st.whtTypes.filter((t) => t.code === code && (!companyId || t.companyId === companyId) && t.effectiveFrom <= date)
    .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0];
  if (!hit) throw new MockError(422, 'wht.unknown_type', `ไม่พบประเภทเงินได้ ${code} ที่มีผลใช้ ณ วันที่ ${date}`);
  return hit;
}

/**
 * Per WHT type (D-14), satang, half away from zero; B = Σ net of the lines carrying that type, r = rate:
 *  deduct          income = B               tax = round(B x r)            expense 0
 *  grossup_always  income = round(B / (1-r)) tax = round(income x r)       expense = tax
 *  grossup_once    income = round(B x (1+r)) tax = round(income x r)       expense = tax
 * `expense` = the tax we bear (gross-up modes). Lines without a type carry no WHT.
 */
export function computeWht(lines: { net: number; whtTypeCode?: string }[], mode: WhtMode, payee: PartySummary, date: IsoDate, st: MockState):
  { lines: WhtLine[]; tax: number; expense: number } {
  const bases = new Map<string, bigint>();
  for (const l of lines) if (l.whtTypeCode) bases.set(l.whtTypeCode, (bases.get(l.whtTypeCode) ?? 0n) + BigInt(l.net));
  const out: WhtLine[] = [];
  let tax = 0n;
  for (const [code, base] of bases) {
    if (base <= 0n) continue;
    const t = whtTypeOf(st, code, payee, date), bp = BigInt(t.rateBp);
    const income = mode === 'deduct' ? base : mode === 'grossup_always' ? divRoundHalfAway(base * BP, BP - bp) : divRoundHalfAway(base * (BP + bp), BP);
    const lineTax = divRoundHalfAway((mode === 'deduct' ? base : income) * bp, BP);
    tax += lineTax;
    out.push({ code, nameTh: t.nameTh, form: formFor(t, payee), base: fromSatang(Number(base)), rate: rateText(t.rateBp), tax: fromSatang(Number(lineTax)), income: fromSatang(Number(income)) });
  }
  return { lines: out, tax: Number(tax), expense: mode === 'deduct' ? 0 : Number(tax) };
}
