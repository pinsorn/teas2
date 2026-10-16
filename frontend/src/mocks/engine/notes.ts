import { ADJUSTS, CREDIT_NOTES, LIVE, REASON_CODES } from '@/domain/doc-types';
import type { DocHeader, DocLine, DocType, MissingItem } from '@/domain/types';
import type { MockState } from '../store';
import { MockError } from './log';
import { divRoundHalfAway, fromSatang, toSatang } from './money';
import { RATE_BP, computeLine, vatBasisOf } from './vat';

type Stored = MockState['docs'][number];
type Part = { header: DocHeader; lines: DocLine[] };

/** An adjustment note: a CN / DN of a tax invoice, or a PCN / PDN of a purchase bill. One engine path for both sides (`ADJUSTS` says which document each adjusts). */
export const isNote = (t: DocType): t is 'CN' | 'DN' | 'PCN' | 'PDN' => ADJUSTS[t] !== undefined;
/** Only the notes of a tax invoice carry the ม.86/10 snapshot and paper: the vendor issues the document of a PCN / PDN, we only record it. */
export const hasSnapshot = (t: DocType): boolean => ADJUSTS[t] === 'TI';
const isCredit = (t: DocType): boolean => CREDIT_NOTES.includes(t);
const ORIG_TH: Record<string, string> = { TI: 'ใบกำกับภาษี', PB: 'บันทึกซื้อ' };
const NOTE_TH: Record<string, string> = { CN: 'ใบลดหนี้', DN: 'ใบเพิ่มหนี้', PCN: 'ใบลดหนี้จากผู้ขาย', PDN: 'ใบเพิ่มหนี้จากผู้ขาย' };
/** The document a note references (the tax invoice of a CN / DN, the purchase bill of a PCN / PDN): of the same company, live or not - `noteProblem` judges that. */
const tiOf = (st: MockState, companyId: string, type: DocType, header: DocHeader): Stored | undefined =>
  st.docs.find((d) => d.id === header.refDocId && d.companyId === companyId && d.type === ADJUSTS[type]);
/** Net of a line in satang (VAT excluded). */
const netOf = (l: DocLine, inclusive: boolean) => computeLine(l, inclusive, true).net;
/** The other live notes of one invoice (a note being checked is not its own predecessor). */
const others = (st: MockState, ti: Stored, selfId?: string) => st.docs.filter((d) => isNote(d.type) && d.id !== selfId && d.header.refDocId === ti.id && LIVE.includes(d.status));
const netsOf = (st: MockState, ti: Stored) => new Map(ti.lines.map((l) => [l.id, netOf(l, !!ti.header.priceIncludesVat)] as const));

/** Server-owned header of a note: its customer / vendor is the original's and its reference is the original's number, whatever the client sent. */
export function noteHeader(st: MockState, companyId: string, type: DocType, header: DocHeader, lines: DocLine[] = []): DocHeader {
  const ti = isNote(type) ? tiOf(st, companyId, type, header) : undefined;
  if (!ti) return header;
  // a user note is priced ex-VAT (rule B needs it): only the engine's own note - every line carries its `vatOverride` (the HTTP boundary strips a client's) - may be inclusive
  const engine = lines.length > 0 && lines.every((l) => l.vatOverride !== undefined);
  return { ...header, partyId: ti.header.partyId, ...(ti.number ? { reference: ti.number } : {}), ...(engine || !header.priceIncludesVat ? {} : { priceIncludesVat: false }) };
}

/** Rule B for line-based notes (Ham, 2026-10-14): a note line's VAT is the change of its OWN invoice line's VAT. The line's VAT still to be credited is tracked from what the
 *  other live notes actually carry (their stored VAT, not a recomputation), so a credit gives back `VAT left - VAT(rest after)` (a debit the mirror) and the notes on a line add up
 *  to the line's VAT to the satang whatever the split or the order of cancels. A correction plan's note is built the same way. Fills `vatOverride` only where the engine has set
 *  none already (a plan's note carries its own); an inclusive-price tax invoice is only adjusted by a plan (`noteProblem`) - a purchase bill priced with VAT is fine (no plan exists
 *  for it): the note is ex-VAT and the bill line's own VAT is what is left to give back.
 *  Exact once the line is fully credited. Between notes it may be 0.01 off after a mid-sequence cancel (the stored VAT of a surviving note is immutable, so the line's remaining VAT
 *  is the invoice's less what the survivors carry, while a fresh rate x net differs by a satang); the next note on the line absorbs it, so the final sum is always the line's VAT. */
export function withNoteVat<B extends Part>(st: MockState, companyId: string, type: DocType, body: B, selfId?: string): B {
  if (!isNote(type) || body.header.priceIncludesVat || !vatBasisOf(st, companyId, type)) return body;
  const ti = tiOf(st, companyId, type, body.header);
  if (!ti || (ADJUSTS[type] === 'TI' && ti.header.priceIncludesVat)) return body;
  const left = netsOf(st, ti); // what is left of each invoice line, net satang: its net, less the credits and plus the debits of the other live notes
  const leftVat = new Map(ti.lines.map((l) => [l.id, computeLine(l, !!ti.header.priceIncludesVat, true).vat] as const)); // and the VAT of that rest
  for (const n of others(st, ti, selfId)) {
    for (const l of n.lines) {
      if (!l.sourceLineId || !left.has(l.sourceLineId)) continue;
      const k = isCredit(n.type) ? -1 : 1, r = computeLine(l, !!n.header.priceIncludesVat, true);
      left.set(l.sourceLineId, left.get(l.sourceLineId)! + k * r.net);
      leftVat.set(l.sourceLineId, leftVat.get(l.sourceLineId)! + k * r.vat);
    }
  }
  const vat = (code: DocLine['taxCode'], x: number) => Number(divRoundHalfAway(BigInt(x) * RATE_BP[code], 10000n));
  const lines = body.lines.map((l) => {
    const src = l.sourceLineId ? ti.lines.find((x) => x.id === l.sourceLineId) : undefined;
    if (!src) return l;
    const n = netOf(l, false), cur = left.get(src.id)!, next = isCredit(type) ? cur - n : cur + n, vatBefore = leftVat.get(src.id)!, vatAfter = vat(l.taxCode, next);
    left.set(src.id, next);
    leftVat.set(src.id, vatAfter);
    if (l.vatOverride !== undefined || src.taxCode !== l.taxCode) return l;
    return { ...l, vatOverride: fromSatang(isCredit(type) ? vatBefore - vatAfter : vatAfter - vatBefore) };
  });
  return { ...body, lines };
}

/** Shape of a note's own fields (the engine's "ยังขาดอะไร"): the original it adjusts and why. */
export function noteMissing(type: DocType, h: DocHeader): MissingItem[] {
  const out: MissingItem[] = [];
  if (!h.refDocId) out.push({ field: 'header.refDocId', message: `ต้องอ้างอิง${ORIG_TH[ADJUSTS[type]!]}` });
  if (!h.reasonCode) out.push({ field: 'header.reasonCode', message: 'ต้องระบุเหตุผล' });
  else if (!REASON_CODES[type]?.includes(h.reasonCode)) out.push({ field: 'header.reasonCode', message: 'เหตุผลไม่ถูกต้อง' });
  else if (h.reasonCode === 'OTHER' && !h.reasonText?.trim()) out.push({ field: 'header.reasonText', message: 'ต้องระบุเหตุผลเพิ่มเติม (อื่น ๆ)' });
  return out;
}

/** The rules a note must meet against the document it references (server-owned, so the client cannot skip them): the original, its lines, the date and the G3 cap.
 *  `selfId`: the note being checked when it already exists (reissue), so it does not count against itself. */
export function noteProblem(st: MockState, companyId: string, type: DocType, body: Part, selfId?: string): MockError | undefined {
  if (!isNote(type) || !body.header.refDocId) return undefined; // a missing reference is `noteMissing`'s
  const ti = tiOf(st, companyId, type, body.header), orig = ORIG_TH[ADJUSTS[type]!], pre = type === 'PCN' ? 'pcn' : 'cn';
  if (!ti) return new MockError(422, 'doc.ref_not_found', `ไม่พบ${orig}ที่อ้างอิง`);
  if (!LIVE.includes(ti.status)) return new MockError(422, 'doc.ref_not_live', `${orig} ${ti.number ?? ''} ต้องเป็นฉบับที่ออกแล้วและยังไม่ถูกยกเลิก`);
  if (body.header.documentDate < ti.header.documentDate) return new MockError(422, 'doc.date_before_original', `วันที่ของ${NOTE_TH[type]}ต้องไม่ก่อนวันที่ของ${orig}ที่อ้างอิง (${ti.header.documentDate})`);
  const incl = !!body.header.priceIncludesVat;
  if (ADJUSTS[type] === 'TI' && ti.header.priceIncludesVat && body.lines.some((l) => l.sourceLineId && l.vatOverride === undefined)) { // notes are priced ex-VAT: an inclusive invoice is adjusted by a correction plan (SP2: ledger 193)
    return new MockError(422, 'doc.inclusive_invoice', 'ใบกำกับภาษีที่ราคารวมภาษีแล้วปรับได้ผ่านแผนการแก้ไขของใบกำกับภาษีเท่านั้น');
  }
  for (const l of body.lines) {
    if (l.vatOverride === undefined && netOf(l, incl) <= 0) { // a user note's every line is a positive amount: a credit cannot hide in a debit (or the reverse); the engine's plan lines (vatOverride set) may be signed
      return new MockError(422, 'note.line_not_positive', `รายการ “${l.description}” ต้องมียอดมากกว่า 0.00 บาท`);
    }
    if (!l.sourceLineId) {
      if (isCredit(type) && netOf(l, incl) > 0) return new MockError(422, `${pre}.line_not_referenced`, `รายการ “${l.description}” ต้องอ้างอิงรายการของ${orig}เดิม`);
      continue;
    }
    const src = ti.lines.find((x) => x.id === l.sourceLineId);
    if (!src) return new MockError(422, 'doc.line_not_found', `รายการ “${l.description}” อ้างอิงรายการที่ไม่มีใน${orig}เดิม`);
    if (src.taxCode !== l.taxCode) return new MockError(422, 'doc.tax_code_mismatch', `รายการ “${l.description}” ต้องใช้รหัสภาษีเดียวกับ${orig}เดิม`);
  }
  if (!isCredit(type)) return undefined; // a debit note has no cap
  const left = netsOf(st, ti);
  for (const n of others(st, ti, selfId)) {
    for (const l of n.lines) { // a credit is a CN / PCN line; a negative referenced DN line (stored data - the engine no longer builds one) is a credit as well, a positive one never raises the cap
      const x = netOf(l, !!n.header.priceIncludesVat);
      if (l.sourceLineId && left.has(l.sourceLineId) && (isCredit(n.type) || x < 0)) left.set(l.sourceLineId, left.get(l.sourceLineId)! - (isCredit(n.type) ? x : -x));
    }
  }
  const taken = new Map<string, number>();
  for (const l of body.lines) if (l.sourceLineId && left.has(l.sourceLineId)) taken.set(l.sourceLineId, (taken.get(l.sourceLineId) ?? 0) + netOf(l, incl));
  for (const [id, net] of taken) {
    if (net > left.get(id)!) {
      const src = ti.lines.find((x) => x.id === id)!;
      return new MockError(422, `${pre}.exceeds_original`, `รายการ “${src.description}” ลดหนี้เกินยอดเดิม ลดหนี้ได้อีกไม่เกิน ${fromSatang(Math.max(0, left.get(id)!))} บาท`);
    }
  }
  return undefined;
}

/** The ม.86/10 values of a note at the moment it is issued (the paper prints these and never recomputes): the invoice's net, the correct value after this note (the net of the
 *  invoice less the other live credits plus the other live debits, then this note), the difference (this note's net) and the VAT on it. */
export function adjustSnapshot(st: MockState, ti: Stored, n: Stored): NonNullable<Stored['adjustSnapshot']> {
  const signed = (x: Stored) => (x.type === 'CN' ? -1 : 1) * toSatang(x.totals.net);
  const correct = toSatang(ti.totals.net) + others(st, ti, n.id).reduce((a, x) => a + signed(x), 0) + signed(n);
  return { originalNet: ti.totals.net, correctNet: fromSatang(correct), diffNet: n.totals.net, vat: n.totals.vat };
}

/** Credit notes of one invoice, oldest first, for the paper's running "correct value": the notes issued up to and including `self`. */
export function notesUpTo(st: MockState, ti: Stored, selfId: string): Stored[] {
  const all = st.docs.filter((d) => isNote(d.type) && d.header.refDocId === ti.id && LIVE.includes(d.status));
  const order = (d: Stored) => `${d.issuedAt ?? ''}|${String(st.docs.indexOf(d)).padStart(6, '0')}`;
  const me = all.find((d) => d.id === selfId);
  return me ? all.filter((d) => order(d) <= order(me)).sort((a, b) => (order(a) < order(b) ? -1 : 1)) : [];
}
