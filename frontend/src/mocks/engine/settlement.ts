import { ADJUSTS, CREDIT_NOTES, GROUPS, LIVE, SETTLES, isTypeAvailable } from '@/domain/doc-types';
import type { Allocation, ComputeResult, DocHeader, DocLine, DocTotals, DocType, PartySummary, WhtFrozen, WhtLine } from '@/domain/types';
import type { MockState } from '../store';
import { bahtText } from './bahtText';
import { MockError } from './log';
import { divRoundHalfAway, fromSatang, toSatang } from './money';
import { computeDoc, vatBasisOf, vatOf } from './vat';
import { computeWht, whtTypeOf } from './wht';

type Stored = MockState['docs'][number];
type Part = { header: DocHeader; lines: DocLine[]; allocations?: Allocation[]; whtFrozen?: WhtFrozen };

const money = (m: string | undefined, code: string): number => {
  try { return m === undefined || m === '' ? 0 : toSatang(m); } catch { throw new MockError(422, code, `จำนวนเงินไม่ถูกต้อง: ${m}`); }
};
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/** SP0 7.11: outstanding = total - active CN/PCN + active DN/PDN - active settlements, from the active links alone. */
export function balanceOf(st: MockState, d: Stored): { out: number; paid: number; settled: boolean } {
  let out = toSatang(d.totals.total), paid = 0, settled = false;
  for (const l of st.links) {
    if (!l.active || l.to !== d.id) continue;
    const amt = toSatang(l.amount ?? '0.00');
    if (l.kind === 'settles') { out -= amt; paid += amt; settled = true; }
    else if (l.kind === 'adjusts') {
      const t = st.docs.find((x) => x.id === l.from)?.type;
      if (t === 'CN' || t === 'PCN') out -= amt; else if (t === 'DN' || t === 'PDN') out += amt;
    }
  }
  return { out, paid, settled };
}

/** BL: the grouped list as stored. The amount is the target's outstanding NOW, read here (a client amount is ignored); `keep` = the allocations
 *  already on an issued BL being revised, whose amount stands (the statement says what was owed when it was issued). A target of another company keeps '0.00': groupError refuses it. */
function cleanGroup(st: MockState, companyId: string, allocs: Allocation[], keep?: Allocation[]): Allocation[] {
  return allocs.map((a) => {
    const target = st.docs.find((d) => d.id === a.targetId && d.companyId === companyId);
    const kept = keep?.find((k) => k.targetId === a.targetId);
    const amount = kept ? kept.amount : target ? fromSatang(balanceOf(st, target).out) : '0.00';
    return { targetId: a.targetId, targetType: a.targetType, ...(target?.number ? { targetNumber: target.number } : {}), ...(target?.header.partyId ? { partyId: target.header.partyId } : {}), amount };
  });
}

/** BL total = the sum of the grouped amounts, summed by the server. Nothing is taxed or posted on a BL: net = total, VAT 0.00. */
export function groupTotals(body: Part, lineTotals: DocTotals): DocTotals {
  const total = fromSatang(sum((body.allocations ?? []).map((a) => money(a.amount, 'settle.invalid_amount'))));
  return { ...lineTotals, net: total, vat: '0.00', total, amountInWords: bahtText(total) };
}

/** The command-time rules for a BL list: same company, same party, a groupable type, still open with something owing.
 *  `prior`: the list an issued statement already carries - a kept target that has since been paid in full does not block revising the rest. */
function groupError(st: MockState, companyId: string, type: DocType, header: DocHeader, allocs: Allocation[] | undefined, prior?: Allocation[]): MockError | undefined {
  const seen = new Set<string>();
  for (const a of allocs ?? []) {
    const target = st.docs.find((d) => d.id === a.targetId);
    if (!target || target.companyId !== companyId) return new MockError(422, 'group.target_not_found', 'ไม่พบเอกสารที่ต้องการวางบิล');
    const label = target.number ?? target.id;
    if (seen.has(a.targetId)) return new MockError(422, 'group.duplicate_target', `เลือก ${label} ซ้ำ`);
    seen.add(a.targetId);
    if (!GROUPS[type]!.includes(target.type) || a.targetType !== target.type || !isTypeAvailable(target.type, vatOf(st, companyId))) {
      return new MockError(422, 'group.wrong_type', `${label} วางบิลไม่ได้ (วางบิลได้เฉพาะใบกำกับภาษีและใบแจ้งหนี้)`);
    }
    if (!LIVE.includes(target.status)) return new MockError(422, 'group.target_not_open', `${label} ไม่อยู่ในสถานะที่วางบิลได้`);
    if (target.header.partyId !== header.partyId) return new MockError(422, 'group.party_mismatch', `${label} เป็นของคู่ค้าคนละราย วางบิลรวมกันไม่ได้`);
    if (balanceOf(st, target).out <= 0 && !prior?.some((p) => p.targetId === a.targetId)) return new MockError(422, 'group.nothing_outstanding', `${label} ไม่มียอดค้างชำระ`);
  }
  return undefined;
}

/** Allocation list as stored: engine-set `targetNumber`, amounts normalised, anything else dropped. A type that settles nothing refuses allocations (a BL groups: its own list). */
export function cleanAllocations(st: MockState, companyId: string, type: DocType, allocs: Allocation[] | undefined, keep?: Allocation[]): Allocation[] | undefined {
  if (allocs === undefined) return undefined;
  if (GROUPS[type]) return cleanGroup(st, companyId, allocs, keep);
  if (!SETTLES[type]) {
    if (allocs.length) throw new MockError(422, 'settle.not_allowed', 'เอกสารประเภทนี้จัดสรรการชำระไม่ได้');
    return undefined;
  }
  return allocs.map((a) => {
    const target = st.docs.find((d) => d.id === a.targetId && d.companyId === companyId);
    const wht = a.wht === undefined || a.wht === '' ? undefined : fromSatang(money(a.wht, 'settle.invalid_wht'));
    return {
      targetId: a.targetId, targetType: a.targetType, ...(target?.number ? { targetNumber: target.number } : {}), ...(target?.header.partyId ? { partyId: target.header.partyId } : {}),
      amount: fromSatang(money(a.amount, 'settle.invalid_amount')), ...(wht ? { wht } : {}),
      ...(a.whtTypeCode ? { whtTypeCode: a.whtTypeCode } : {}), ...(a.certNumber ? { certNumber: a.certNumber } : {}),
    };
  });
}

/** A withholding certificate number belongs to withheld tax: on an allocation with no WHT it would put a certificate for 0.00 on TX2's register. */
export const certError = (a: Allocation, label: string, wht: number): MockError | undefined =>
  a.certNumber && wht <= 0 ? new MockError(422, 'rc.cert_without_wht', `${label}: ระบุเลขที่หนังสือรับรองหัก ณ ที่จ่ายได้เฉพาะรายการที่มีภาษีถูกหัก`) : undefined;

/** Allocations compared for "did the money change": certificate numbers and engine-set labels do not count. */
export const fiscalAllocations = (a: Allocation[] | undefined) =>
  JSON.stringify((a ?? []).map((x) => [x.targetId, x.targetType, toSatang(x.amount), toSatang(x.wht ?? '0.00'), x.whtTypeCode ?? '']));

/** RC / PV header defaults the engine fills when absent, so "ยังขาดอะไร" never asks for them (D-15). A foreign payee is grossed up every time unless the user chose otherwise (A.5, `[SP-R]`). */
export function payDefaults(st: MockState, companyId: string, type: DocType, header: DocHeader): DocHeader {
  if (!SETTLES[type]) return header;
  const bank = st.bankAccounts.find((b) => b.companyId === companyId && b.default)?.id;
  const foreign = st.parties.find((p) => p.id === header.partyId && p.companyId === companyId)?.entityKind === 'foreign';
  return {
    ...header, paymentMethod: header.paymentMethod ?? 'transfer', ...(header.bankAccountId ?? bank ? { bankAccountId: header.bankAccountId ?? bank } : {}),
    ...(type === 'PV' ? { whtMode: header.whtMode ?? (foreign ? 'grossup_always' : 'deduct') } : {}),
  };
}

/** PV lines paid to a foreign payee: a SERVICE line (a service item, or a line with no item) is used in Thailand - it gets `pnd36` (feeds TX2) and the FOR-SVC type unless one was chosen. Editable: the
 *  defaults are applied ONCE (a line whose `pnd36` is already set - true or false - was defaulted before, so a later "no WHT" stays). */
export function payLines(st: MockState, companyId: string, type: DocType, header: DocHeader, lines: DocLine[]): DocLine[] {
  if (type !== 'PV' || st.parties.find((p) => p.id === header.partyId && p.companyId === companyId)?.entityKind !== 'foreign') return lines;
  return lines.map((l) => {
    const item = l.itemId ? st.items.find((i) => i.id === l.itemId && i.companyId === companyId) : undefined;
    if (l.pnd36 !== undefined) return l;
    return !item || item.kind === 'service' ? { ...l, pnd36: true, ...(l.whtTypeCode ? {} : { whtTypeCode: 'FOR-SVC' }) } : { ...l, pnd36: false };
  });
}

const placeholderPayee = (): PartySummary => ({ id: '', kind: 'vendor', code: '', name: '', vatRegistered: false, paymentTermDays: 0, entityKind: 'juristic' });
const payeeOf = (st: MockState, companyId: string, partyId?: string): PartySummary =>
  st.parties.find((p) => p.id === partyId && p.companyId === companyId) ?? placeholderPayee();

const noteSign = (n: { type: DocType }) => (CREDIT_NOTES.includes(n.type) ? -1n : 1n);
const liveNotesOf = (st: MockState, bill: Stored) => st.docs.filter((n) => LIVE.includes(n.status) && n.companyId === bill.companyId && ADJUSTS[n.type] === 'PB' && n.header.refDocId === bill.id);

/** A bill's total as adjusted by its live vendor credit / debit notes (satang): what a full payment of the bill covers. */
export const adjustedTotal = (st: MockState, bill: Stored): bigint =>
  BigInt(toSatang(bill.totals.total)) + liveNotesOf(st, bill).reduce((x, n) => x + noteSign(n) * BigInt(toSatang(n.totals.total)), 0n);

/** B: the bill's current WHT base per WHT type (satang) - its typed lines (the type STORED on the line, never the item master) at their pre-VAT net after the live notes that touch that line (rule B:
 *  a PCN lowers it, a PDN raises it). Only a PB carries typed lines (EX is P4). */
export function billBases(st: MockState, bill: Stored): Map<string, bigint> {
  const basis = vatBasisOf(st, bill.companyId, 'PB'), notes = liveNotesOf(st, bill), out = new Map<string, bigint>();
  const nets = computeDoc(bill.lines, !!bill.header.priceIncludesVat, basis).lines;
  bill.lines.forEach((l, i) => {
    if (!l.whtTypeCode) return;
    let net = BigInt(toSatang(nets[i].net));
    for (const n of notes) {
      const nn = computeDoc(n.lines, !!n.header.priceIncludesVat, basis).lines;
      n.lines.forEach((nl, j) => { if (nl.sourceLineId === l.id) net += noteSign(n) * BigInt(toSatang(nn[j].net)); });
    }
    out.set(l.whtTypeCode, (out.get(l.whtTypeCode) ?? 0n) + net);
  });
  return out;
}

/** WHT of a PV, fixed at the moment it is issued / re-saved (C1, D-14): one line per WHT type over its own lines AND the bills it pays, rates from `st.whtTypes`, the formula `computeWht` (F5).
 *  I1 - cumulative per bill and type: this voucher's base = round(B x paid share) - the bases already stored on the bill's other live vouchers, where B is the bill's base NOW and the paid share
 *  counts every live voucher of the bill plus this one (1 exactly once the bill is paid up). So the last voucher absorbs rounding and every note that landed in between. A negative result
 *  (an earlier voucher already over-withheld) is 0: WHT is not refunded by a later payment - flagged `clamped`. `selfId`: this voucher's own current links are not counted (revise / preview). */
export function freezeWht(st: MockState, companyId: string, body: Part, selfId?: string): WhtFrozen {
  const nets = computeDoc(body.lines, !!body.header.priceIncludesVat, vatBasisOf(st, companyId, 'PV')).lines;
  const bases: WhtFrozen['bases'] = [];
  for (const a of body.allocations ?? []) {
    const bill = st.docs.find((d) => d.id === a.targetId && d.companyId === companyId && d.type === 'PB');
    const adjusted = bill ? adjustedTotal(st, bill) : 0n;
    if (!bill || adjusted <= 0n) continue;
    const paid = BigInt(st.links.filter((l) => l.active && l.kind === 'settles' && l.to === bill.id && l.from !== selfId).reduce((n, l) => n + toSatang(l.amount ?? '0.00'), 0) + money(a.amount, 'settle.invalid_amount'));
    const others = st.docs.filter((d) => d.type === 'PV' && d.companyId === companyId && d.id !== selfId && LIVE.includes(d.status)).flatMap((d) => d.whtFrozen?.bases ?? []).filter((x) => x.targetId === bill.id);
    for (const [code, B] of billBases(st, bill)) {
      if (B <= 0n) continue;
      // remaining-balance rule: what is still to be withheld on the bill (B less the bases on its other live vouchers), shared by this payment's part of what the bill still owed just before it;
      // the voucher that pays the bill up takes exactly the remainder, so the sum is B and no base exceeds its own pre-VAT payment (GP-I1)
      const left = B - others.filter((x) => x.whtTypeCode === code).reduce((n, x) => n + BigInt(toSatang(x.base)), 0n);
      const owed = adjusted - (paid - BigInt(money(a.amount, 'settle.invalid_amount'))); // the bill's outstanding just before this voucher
      const raw = paid >= adjusted || owed <= 0n ? left : divRoundHalfAway(left * BigInt(money(a.amount, 'settle.invalid_amount')), owed);
      const base = raw < 0n ? 0n : raw;
      bases.push({ targetId: bill.id, whtTypeCode: code, base: fromSatang(Number(base)), ...(raw < 0n ? { clamped: true as const } : {}), ...(paid >= adjusted ? { full: true as const, billBase: fromSatang(Number(B)) } : {}) });
    }
  }
  const w = computeWht([...body.lines.map((l, i) => ({ net: toSatang(nets[i].net), whtTypeCode: l.whtTypeCode })), ...bases.map((b) => ({ net: toSatang(b.base), whtTypeCode: b.whtTypeCode }))],
    body.header.whtMode ?? 'deduct', payeeOf(st, companyId, body.header.partyId), body.header.documentDate, st);
  return { bases, lines: w.lines, expense: fromSatang(w.expense), cashDelta: fromSatang(w.cashDelta) };
}

/** What the company pays out on a document (P4 m1): its settled total plus, for a voucher, the WHT it bears (gross-up). The approval policy and the approved amount are judged on this figure. */
export function payoutOf(st: MockState, companyId: string, d: { id?: string; type: DocType; header: DocHeader; lines: DocLine[]; allocations?: Allocation[]; totals: { total: string }; whtFrozen?: WhtFrozen }): string {
  if (d.type !== 'PV') return d.totals.total;
  const f = d.whtFrozen ?? freezeWht(st, companyId, { header: d.header, lines: d.lines, ...(d.allocations ? { allocations: d.allocations } : {}) }, d.id);
  return fromSatang(toSatang(d.totals.total) + toSatang(f.expense));
}

/** The stored withholding of a voucher as satang figures: tax, the part we bear (WhtExpense) and what the payee receives less the base (cash delta). */
export const frozenFigures = (f: WhtFrozen) => ({ lines: f.lines, tax: sum(f.lines.map((l) => toSatang(l.tax))), expense: toSatang(f.expense), cashDelta: toSatang(f.cashDelta) });

/**
 * RC / PV totals. RC: total = Σ allocation amounts + deposit remainder + cash-bill lines; the customer withholds Σ allocation wht; cash = total - wht.
 * PV: total = Σ allocation amounts + Σ line totals + the prepayment (FN3); WHT per type from the lines; deduct: cash = total - wht, gross-up: cash = total (we bear the tax).
 */
export function settleTotals(st: MockState, companyId: string, type: DocType, body: Part, lineTotals: DocTotals, selfId?: string): DocTotals {
  const alloc = sum((body.allocations ?? []).map((a) => money(a.amount, 'settle.invalid_amount')));
  const lines = toSatang(lineTotals.total);
  let total: number, wht: number, cash: number;
  if (type === 'RC') {
    const dep = money(body.header.depositAmount, 'rc.invalid_deposit');
    total = alloc + dep + lines;
    wht = sum((body.allocations ?? []).map((a) => money(a.wht, 'settle.invalid_wht')));
    cash = total - wht;
  } else {
    total = alloc + lines + money(body.header.depositAmount, 'pv.invalid_deposit'); // FN3: the part paid in advance to the vendor counts in the voucher's total and cash
    const w = frozenFigures(body.whtFrozen ?? freezeWht(st, companyId, body, selfId)); // the voucher's own stored figures when it has them
    wht = w.tax;
    cash = total + w.cashDelta; // deduct: -tax; gross-up always: 0; gross-up once: income - tax - B per type
  }
  return { ...lineTotals, total: fromSatang(total), wht: fromSatang(wht), cash: fromSatang(cash), amountInWords: bahtText(fromSatang(total)) };
}

/**
 * The command-time rules for an RC / PV allocation list (undefined = fine). `outstanding(id)` reads the target's balance NOW.
 * `partyExempt`: target ids a correction plan retargeted to a reissued invoice (its customer may have changed) - every other rule still applies, to them and to every other target.
 * `prior`: the allocations this document already carries (revise / compute / reissue). A carried allocation keeps the party recorded on it (engine-set from its target when it was created or moved),
 *  and one whose amount is unchanged is not re-judged against outstanding (a later credit may legitimately have left it negative); a NEW or CHANGED allocation is checked in full.
 */
export function allocationError(st: MockState, companyId: string, type: DocType, header: DocHeader, allocs: Allocation[] | undefined,
  outstanding: (id: string) => number, opts: { partyExempt?: string[]; prior?: Allocation[]; priorParty?: string } = {}): MockError | undefined {
  if (!allocs?.length) return undefined;
  const settles = SETTLES[type];
  if (!settles) return new MockError(422, 'settle.not_allowed', 'เอกสารประเภทนี้จัดสรรการชำระไม่ได้');
  const seen = new Set<string>();
  for (const a of allocs) {
    const target = st.docs.find((d) => d.id === a.targetId);
    if (!target || target.companyId !== companyId) return new MockError(422, 'settle.target_not_found', 'ไม่พบเอกสารที่ต้องการชำระ');
    const label = target.number ?? target.id;
    if (seen.has(a.targetId)) return new MockError(422, 'settle.duplicate_target', `เลือก ${label} ซ้ำ รวมยอดเป็นรายการเดียว`);
    seen.add(a.targetId);
    if (!settles.includes(target.type) || a.targetType !== target.type) return new MockError(422, 'settle.wrong_type', `${label} ชำระด้วยเอกสารนี้ไม่ได้`);
    // AC3: an opening item belongs to one side (a receipt settles receivables, a voucher payables / employee claims): the ledger would otherwise post the cash with nothing cleared
    if (target.type === 'OB' && !(type === 'RC' ? ['AR'] : ['AP', 'EMP']).includes(target.header.obSide ?? '')) return new MockError(422, 'settle.wrong_type', `${label} ชำระด้วยเอกสารนี้ไม่ได้ (ยอดยกมาประเภทนี้ใช้ ${type === 'RC' ? 'ใบสำคัญจ่ายหรือการหักกลบ' : 'ใบเสร็จรับเงิน'})`);
    if (!LIVE.includes(target.status)) return new MockError(422, 'settle.target_not_open', `${label} ไม่อยู่ในสถานะที่ชำระได้`);
    const was = opts.prior?.find((p) => p.targetId === a.targetId);
    // recorded when it was legitimately created / moved - and exempt only while the document's own party is still the one it was issued to
    const carriedParty = !!was?.partyId && was.partyId === target.header.partyId && opts.priorParty === header.partyId;
    if (!opts.partyExempt?.includes(a.targetId) && !carriedParty && target.header.partyId !== header.partyId) return new MockError(422, 'settle.party_mismatch', `${label} เป็นของคู่ค้าคนละราย`);
    const amount = money(a.amount, 'settle.invalid_amount');
    if (amount <= 0) return new MockError(422, 'settle.invalid_amount', `จำนวนที่ชำระ ${label} ต้องมากกว่า 0`);
    const out = outstanding(a.targetId);
    if (amount > out && !(was && toSatang(was.amount) === amount)) return new MockError(422, 'settle.over_allocation', `ชำระ ${label} เกินยอดค้างชำระ (ค้างชำระ ${fromSatang(out)} บาท)`);
    const wht = money(a.wht, 'settle.invalid_wht');
    if (wht < 0) return new MockError(422, 'settle.invalid_wht', `ภาษีหัก ณ ที่จ่ายของ ${label} ต้องไม่ติดลบ`);
    if (wht > amount) return new MockError(422, 'rc.wht_exceeds_amount', `ภาษีหัก ณ ที่จ่ายของ ${label} เกินยอดที่ชำระ`);
    if (a.whtTypeCode) { try { whtTypeOf(st, a.whtTypeCode, payeeOf(st, companyId, header.partyId), header.documentDate); } catch (e) { return e as MockError; } }
    const cert = certError(a, label, wht);
    if (cert) return cert;
    if (wht > 0 && type !== 'RC') return new MockError(422, 'settle.wht_not_allowed', 'ภาษีหัก ณ ที่จ่ายของใบสำคัญจ่ายคำนวณจากรายการ ไม่ระบุที่การจัดสรร');
  }
  if (sum(allocs.map((a) => money(a.wht, 'settle.invalid_wht'))) > sum(allocs.map((a) => money(a.amount, 'settle.invalid_amount')))) {
    return new MockError(422, 'rc.wht_exceeds_amount', 'ภาษีหัก ณ ที่จ่ายรวมเกินยอดที่ชำระ');
  }
  return undefined;
}

/** The account the Cash role posts to: the chosen bank account, or the company's cash box when paid in cash. */
export function cashBankId(st: MockState, companyId: string, header: DocHeader): string | undefined {
  if (header.paymentMethod === 'cash') return st.bankAccounts.find((b) => b.companyId === companyId && b.kind === 'cash')?.id ?? header.bankAccountId;
  return header.bankAccountId;
}

/** The account an RC / PV really uses (the cash box when paid in cash), for the rules that judge it. Other types have none. */
export const resolvedBankId = (st: MockState, companyId: string, type: DocType, header: DocHeader | undefined): string | undefined =>
  type === 'OB' ? header?.bankAccountId : // AC3: an in-transit item of an opening balance sits on the account it was listed under
  header && SETTLES[type] ? (header.paymentMethod === 'cash' ? cashBankId(st, companyId, header) : header.bankAccountId) : undefined;

/** Frozen at issue and at every revise (CLAUDE.md money rule): an RC / PV keeps the account's name, number and kind as they were then, and the paper reads only this. Server-owned: whatever a caller sent is replaced. */
export function withBankSnapshot(st: MockState, companyId: string, type: DocType, header: DocHeader): DocHeader {
  if (!SETTLES[type]) return header;
  const { bankSnapshot: _s, ...rest } = header; void _s;
  const b = st.bankAccounts.find((x) => x.id === cashBankId(st, companyId, header));
  return b ? { ...rest, bankSnapshot: { kind: b.kind, ...(b.bankName ? { bankName: b.bankName } : {}), ...(b.accountNo ? { accountNo: b.accountNo } : {}), accountName: b.nameTh } } : rest;
}

/** Rules about the money that moves, not the open items: bank account of this company, no negative deposit, no input VAT on a voucher line, no negative cash. */
export function payError(st: MockState, companyId: string, type: DocType, body: Part): MockError | undefined {
  if (!SETTLES[type]) return undefined;
  const h = body.header;
  if (h.bankAccountId && !st.bankAccounts.some((b) => b.id === h.bankAccountId && b.companyId === companyId)) return new MockError(422, 'pay.invalid_bank_account', 'บัญชีธนาคารที่เลือกไม่ใช่ของบริษัทนี้');
  // I1: money to an employee is a reimbursement of claims only - no own lines (their WHT would be a ภ.ง.ด.3 certificate to an employee, and no approval stands behind them)
  if (type === 'PV' && payeeOf(st, companyId, h.partyId).kind === 'employee' && (body.lines.length > 0 || !body.allocations?.length || body.allocations.some((x) => x.targetType !== 'EX' && x.targetType !== 'OB'))) {
    return new MockError(422, 'pv.employee_claims_only', 'ใบสำคัญจ่ายถึงพนักงานจ่ายได้เฉพาะใบเบิกค่าใช้จ่ายที่อนุมัติแล้ว ไม่มีรายการของตัวเอง บันทึกเป็นใบเบิกค่าใช้จ่ายแล้วจ่ายจากใบเบิก');
  }
  if (type === 'RC' && money(h.depositAmount, 'rc.invalid_deposit') < 0) return new MockError(422, 'rc.invalid_deposit', 'เงินรับล่วงหน้าต้องไม่ติดลบ');
  if (type === 'PV' && money(h.depositAmount, 'pv.invalid_deposit') < 0) return new MockError(422, 'pv.invalid_deposit', 'เงินจ่ายล่วงหน้าต้องไม่ติดลบ');
  if (type === 'PV' && body.lines.some((l) => l.taxCode !== 'EX')) {
    return new MockError(422, 'pv.input_vat_needs_bill', 'ใบสำคัญจ่ายไม่มีภาษีซื้อ รายการที่มีภาษีซื้อต้องมีใบกำกับภาษี กด “บันทึกซื้อ (มีใบกำกับภาษี)” เพื่อบันทึกเป็นบันทึกซื้อแล้วจ่ายชำระ');
  }
  if (toSatang(settleTotals(st, companyId, type, body, computeDoc(body.lines, !!h.priceIncludesVat, vatBasisOf(st, companyId, type)).totals).cash!) < 0) return new MockError(422, 'pay.negative_cash', 'ยอดเงินที่รับ/จ่ายสุทธิติดลบ ตรวจจำนวนเงินและภาษีหัก ณ ที่จ่าย');
  return undefined;
}

/** Every command-time rule of an RC / PV, first violation wins. */
export const settleProblem = (st: MockState, companyId: string, type: DocType, body: Part, outstanding: (id: string) => number, opts: { partyExempt?: string[]; prior?: Allocation[]; priorParty?: string } = {}) =>
  GROUPS[type] ? groupError(st, companyId, type, body.header, body.allocations, opts.prior) : allocationError(st, companyId, type, body.header, body.allocations, outstanding, opts) ?? payError(st, companyId, type, body);

/** RC suggestion per allocation: round(service net of the target x rate x amount / target total), the target's service lines' WHT type. */
export function suggestWht(st: MockState, companyId: string, header: DocHeader, allocs: Allocation[]): NonNullable<ComputeResult['allocation']>['suggestedWht'] {
  const payee = payeeOf(st, companyId, header.partyId);
  const out: NonNullable<ComputeResult['allocation']>['suggestedWht'] = [];
  for (const a of allocs) {
    const target = st.docs.find((d) => d.id === a.targetId && d.companyId === companyId);
    if (!target) continue;
    const total = BigInt(toSatang(target.totals.total)), amount = BigInt(money(a.amount, 'settle.invalid_amount'));
    if (total <= 0n || amount <= 0n) continue;
    const nets = computeDoc(target.lines, !!target.header.priceIncludesVat, vatOf(st, target.companyId)).lines;
    const byType = new Map<string, bigint>();
    target.lines.forEach((l, i) => {
      const code = l.whtTypeCode ?? st.items.find((it) => it.id === l.itemId && it.companyId === companyId)?.whtTypeCode;
      if (code) byType.set(code, (byType.get(code) ?? 0n) + BigInt(toSatang(nets[i].net)));
    });
    let wht = 0n, main: [string, bigint] | undefined;
    for (const [code, base] of byType) {
      if (base <= 0n) continue;
      wht += divRoundHalfAway(base * BigInt(whtTypeOf(st, code, payee, header.documentDate).rateBp) * amount, total * 10000n);
      if (!main || base > main[1]) main = [code, base];
    }
    if (main) out.push({ targetId: a.targetId, wht: fromSatang(Number(wht)), whtTypeCode: main[0] });
  }
  return out;
}

/** Extra compute output for an RC / PV: WHT lines, and the allocated / unallocated split the settlement panel shows. */
export function settleExtras(st: MockState, companyId: string, type: DocType, body: Part): Pick<ComputeResult, 'whtLines' | 'allocation'> {
  if (!SETTLES[type]) return {};
  const allocated = sum((body.allocations ?? []).map((a) => money(a.amount, 'settle.invalid_amount')));
  const whtLines: WhtLine[] | undefined = type === 'PV' ? (body.whtFrozen ?? freezeWht(st, companyId, body)).lines : undefined;
  return {
    ...(whtLines?.length ? { whtLines } : {}),
    allocation: {
      allocated: fromSatang(allocated), unallocated: fromSatang(money(body.header.depositAmount, type === 'RC' ? 'rc.invalid_deposit' : 'pv.invalid_deposit')),
      suggestedWht: type === 'RC' ? suggestWht(st, companyId, body.header, body.allocations ?? []) : [],
    },
  };
}
