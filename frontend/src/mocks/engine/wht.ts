import type { Actor, Allocation, DocLine, IsoDate, PartySummary, WhtLine, WhtMode } from '@/domain/types';
import type { MockState } from '../store';
import { refuseAgent } from './company';
import { MockError, logAudit, stamp, today } from './log';
import { divRoundHalfAway, fromSatang } from './money';

/** Mock WHT reference data. Every rate is a `[SP-R]` fixture (fixtures/wht-types.ts), never "the rule". */
export interface WhtType { code: string; nameTh: string; rateBp: number; incomeType: string; pnd2?: boolean; pnd54?: boolean; effectiveFrom: IsoDate; /** ST3: false = not offered for new lines (kept on every row of the code); absent = active. `version` of the TYPE = the highest over its rows. */ active?: boolean; version?: number }

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
 * Per WHT type (D-14), satang, half away from zero; B = Σ net of the lines carrying that type, r = rate. [SP-R] rates / modes, not a ruled position.
 * In every mode income = what the payee receives + tax:
 *  deduct          income = B                tax = round(B x r)       payee receives B - tax   we bear 0
 *  grossup_always  income = round(B / (1-r)) tax = round(income x r)  payee receives B         we bear tax
 *  grossup_once    income = round(B x (1+r)) tax = round(income x r)  payee receives income - tax   we bear income - B
 *                  (RD ป.96/2543 ตัวอย่างที่ 6 "ออกภาษีให้ครั้งเดียว": 10,000 at 3 % -> income 10,300, tax 309, payee 9,991)
 * `expense` = the tax we bear (WhtExpense); `cashDelta` = Σ (payee receives - B): add it to the lines' total to get the cash we pay.
 * Lines without a type carry no WHT.
 */
export function computeWht(lines: { net: number; whtTypeCode?: string }[], mode: WhtMode, payee: PartySummary, date: IsoDate, st: MockState):
  { lines: WhtLine[]; tax: number; expense: number; cashDelta: number } {
  const bases = new Map<string, bigint>();
  for (const l of lines) if (l.whtTypeCode) bases.set(l.whtTypeCode, (bases.get(l.whtTypeCode) ?? 0n) + BigInt(l.net));
  const out: WhtLine[] = [];
  let tax = 0n, expense = 0n, cashDelta = 0n;
  for (const [code, base] of bases) {
    if (base <= 0n) continue;
    const t = whtTypeOf(st, code, payee, date), bp = BigInt(t.rateBp);
    const income = mode === 'deduct' ? base : mode === 'grossup_always' ? divRoundHalfAway(base * BP, BP - bp) : divRoundHalfAway(base * (BP + bp), BP);
    const lineTax = divRoundHalfAway((mode === 'deduct' ? base : income) * bp, BP);
    const net = mode === 'grossup_always' ? base : income - lineTax; // the payee's cash
    tax += lineTax; cashDelta += net - base; expense += mode === 'deduct' ? 0n : mode === 'grossup_always' ? lineTax : income - base;
    out.push({ code, nameTh: t.nameTh, form: formFor(t, payee), base: fromSatang(Number(base)), rate: rateText(t.rateBp), tax: fromSatang(Number(lineTax)), income: fromSatang(Number(income)), net: fromSatang(Number(net)) });
  }
  return { lines: out, tax: Number(tax), expense: Number(expense), cashDelta: Number(cashDelta) };
}

// ---- ST3 tax settings. A rate is never edited: "change the rate" is the RP3 dated-rate command (log.ts changeTaxRate), RateHistory shows every row. All writes are audited, versioned and refused for an agent.
export interface VatRequest { id: string; companyId: string; register: boolean; effectiveFrom: IsoDate; status: 'pending'; requestedBy: string; requestedAt: string }
const pct = (bp: number) => rateText(bp);
const rowsOf = (st: MockState, companyId: string, code: string) => st.whtTypes.filter((t) => t.companyId === companyId && t.code === code);
export const whtTypeVersion = (st: MockState, companyId: string, code: string): number => Math.max(1, ...rowsOf(st, companyId, code).map((t) => t.version ?? 1));
const conflict = () => new MockError(409, 'record.version_conflict', 'ประเภทภาษีนี้ถูกแก้ไขโดยผู้อื่นแล้ว โหลดข้อมูลใหม่ก่อนบันทึก');

export interface TaxSettingsView {
  vat: { registered: boolean; rate: string; source: string; requests: VatRequest[] };
  taxCodes: { code: string; nameTh: string; rate: string }[];
  whtTypes: { code: string; nameTh: string; incomeType: string; active: boolean; version: number; rate: string; inUse: boolean; rows: { effectiveFrom: IsoDate; rateBp: number; rate: string }[] }[];
}
export function taxSettings(st: MockState, companyId: string): TaxSettingsView {
  const co = st.companies.find((c) => c.id === companyId)!, codes = [...new Set(st.whtTypes.filter((t) => t.companyId === companyId).map((t) => t.code))];
  const carried = (code: string) => st.docs.some((d) => d.companyId === companyId && (d.lines.some((l) => l.whtTypeCode === code) || (d.allocations ?? []).some((a) => a.whtTypeCode === code)));
  return {
    vat: { registered: co.vatRegistered, rate: '7%', source: 'อ้างอิง [SP-R] — ข้อกำหนดภาษีของระบบ ผู้ดูแลระบบไม่กำหนดเอง', requests: (st.vatRequests ?? []).filter((r) => r.companyId === companyId) },
    taxCodes: [{ code: 'S7', nameTh: 'ภาษีมูลค่าเพิ่ม 7%', rate: '7%' }, { code: 'Z0', nameTh: 'ภาษีมูลค่าเพิ่มอัตราศูนย์', rate: '0%' }, { code: 'EX', nameTh: 'ไม่มี VAT / ยกเว้น', rate: '-' }],
    whtTypes: codes.map((code) => {
      const rows = rowsOf(st, companyId, code).sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom)), now = [...rows].reverse().find((r) => r.effectiveFrom <= today()) ?? rows[0];
      return { code, nameTh: rows[0].nameTh, incomeType: rows[0].incomeType, active: rows[0].active !== false, version: whtTypeVersion(st, companyId, code), rate: pct(now.rateBp), inUse: carried(code), rows: rows.map((r) => ({ effectiveFrom: r.effectiveFrom, rateBp: r.rateBp, rate: pct(r.rateBp) })) };
    }),
  };
}

export function setWhtActive(st: MockState, actor: Actor, companyId: string, code: string, b: Record<string, unknown>): TaxSettingsView['whtTypes'][number] {
  refuseAgent(actor);
  const rows = rowsOf(st, companyId, code);
  if (!rows.length) throw new MockError(404, 'tax.type_not_found', 'ไม่พบประเภทภาษีหัก ณ ที่จ่าย');
  if (b.version !== whtTypeVersion(st, companyId, code)) throw conflict();
  if (typeof b.active !== 'boolean') throw new MockError(422, 'record.invalid', 'ต้องระบุว่าเปิดหรือปิดใช้งาน');
  const v = whtTypeVersion(st, companyId, code) + 1, before = rows[0].active !== false;
  for (const r of rows) { r.active = b.active; r.version = v; }
  logAudit(st, actor, companyId, 'tax.wht.active', code, { active: before }, { active: b.active });
  return taxSettings(st, companyId).whtTypes.find((t) => t.code === code)!;
}

/** "Introduced" rule (as ST2 categories): a deactivated type is refused on a line / allocation that is new or changed; a document that already carries it (\`before\`, the stored one) keeps working. */
export function whtInactiveProblem(st: MockState, companyId: string, body: { lines: DocLine[]; allocations?: Allocation[] }, before?: { lines: DocLine[]; allocations?: Allocation[] }): MockError | undefined {
  const off = new Set(st.whtTypes.filter((t) => t.companyId === companyId && t.active === false).map((t) => t.code));
  if (!off.size) return undefined;
  const hit = [
    ...body.lines.filter((l) => l.whtTypeCode && off.has(l.whtTypeCode) && !before?.lines.some((b) => b.id === l.id && b.whtTypeCode === l.whtTypeCode)).map((l) => l.whtTypeCode!),
    ...(body.allocations ?? []).filter((a) => a.whtTypeCode && off.has(a.whtTypeCode) && !before?.allocations?.some((b) => b.targetId === a.targetId && b.whtTypeCode === a.whtTypeCode)).map((a) => a.whtTypeCode!),
  ][0];
  return hit ? new MockError(422, 'wht.type_inactive', 'ประเภทภาษีหัก ณ ที่จ่าย “' + hit + '” ปิดใช้งานแล้ว ทางออก: เลือกประเภทอื่น หรือเปิดใช้งานประเภทนี้ในหน้าตั้งค่าภาษี') : undefined;
}

/** A dated REQUEST to change the VAT registration (the switch itself is SP4: the mock never flips the company's flag). One pending request at a time. */
export function requestVatChange(st: MockState, actor: Actor, companyId: string, b: Record<string, unknown>): VatRequest {
  refuseAgent(actor);
  const co = st.companies.find((c) => c.id === companyId)!, date = typeof b.effectiveFrom === 'string' ? b.effectiveFrom : '';
  if (typeof b.register !== 'boolean') throw new MockError(422, 'record.invalid', 'ต้องระบุว่าขอจดทะเบียนหรือขอยกเลิกการจดทะเบียน VAT');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) throw new MockError(422, 'record.invalid', 'ต้องระบุวันที่มีผล');
  if (date < today()) throw new MockError(422, 'tax.vat_date_past', 'วันที่มีผลต้องเป็นวันนี้หรืออนาคต');
  if (b.register === co.vatRegistered) throw new MockError(422, 'tax.vat_no_change', co.vatRegistered ? 'บริษัทจดทะเบียน VAT อยู่แล้ว' : 'บริษัทยังไม่ได้จดทะเบียน VAT');
  if ((st.vatRequests ?? []).some((r) => r.companyId === companyId && r.status === 'pending')) throw new MockError(409, 'tax.vat_request_pending', 'มีคำขอเปลี่ยนสถานะ VAT ที่รอดำเนินการอยู่แล้ว');
  const r: VatRequest = { id: 'vatreq-' + ((st.vatRequests ?? []).length + 1), companyId, register: b.register, effectiveFrom: date, status: 'pending', requestedBy: actor.name, requestedAt: stamp() };
  (st.vatRequests ??= []).push(r);
  logAudit(st, actor, companyId, 'tax.vat_request', r.id, { registered: co.vatRegistered }, { register: r.register, effectiveFrom: date });
  return r;
}
