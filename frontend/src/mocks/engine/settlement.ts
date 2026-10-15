import { GROUPS, LIVE, SETTLES, isTypeAvailable } from '@/domain/doc-types';
import type { Allocation, ComputeResult, DocHeader, DocLine, DocTotals, DocType, PartySummary, WhtLine } from '@/domain/types';
import type { MockState } from '../store';
import { bahtText } from './bahtText';
import { MockError } from './log';
import { divRoundHalfAway, fromSatang, toSatang } from './money';
import { computeDoc, vatOf } from './vat';
import { computeWht, whtTypeOf } from './wht';

type Stored = MockState['docs'][number];
type Part = { header: DocHeader; lines: DocLine[]; allocations?: Allocation[] };

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

/** Allocations compared for "did the money change": certificate numbers and engine-set labels do not count. */
export const fiscalAllocations = (a: Allocation[] | undefined) =>
  JSON.stringify((a ?? []).map((x) => [x.targetId, x.targetType, toSatang(x.amount), toSatang(x.wht ?? '0.00'), x.whtTypeCode ?? '']));

/** RC / PV header defaults the engine fills when absent, so "ยังขาดอะไร" never asks for them (D-15). */
export function payDefaults(st: MockState, companyId: string, type: DocType, header: DocHeader): DocHeader {
  if (!SETTLES[type]) return header;
  const bank = st.bankAccounts.find((b) => b.companyId === companyId && b.default)?.id;
  return {
    ...header, paymentMethod: header.paymentMethod ?? 'transfer', ...(header.bankAccountId ?? bank ? { bankAccountId: header.bankAccountId ?? bank } : {}),
    ...(type === 'PV' ? { whtMode: header.whtMode ?? 'deduct' } : {}),
  };
}

const placeholderPayee = (): PartySummary => ({ id: '', kind: 'vendor', code: '', name: '', vatRegistered: false, paymentTermDays: 0, entityKind: 'juristic' });
const payeeOf = (st: MockState, companyId: string, partyId?: string): PartySummary =>
  st.parties.find((p) => p.id === partyId && p.companyId === companyId) ?? placeholderPayee();

/** WHT of a PV from its lines (D-14): one line per WHT type, rates from `st.whtTypes`. */
export function whtOf(st: MockState, companyId: string, header: DocHeader, lines: DocLine[]) {
  const nets = computeDoc(lines, !!header.priceIncludesVat, vatOf(st, companyId)).lines;
  return computeWht(lines.map((l, i) => ({ net: toSatang(nets[i].net), whtTypeCode: l.whtTypeCode })), header.whtMode ?? 'deduct',
    payeeOf(st, companyId, header.partyId), header.documentDate, st);
}

/**
 * RC / PV totals. RC: total = Σ allocation amounts + deposit remainder + cash-bill lines; the customer withholds Σ allocation wht; cash = total - wht.
 * PV: total = Σ allocation amounts + Σ line totals; WHT per type from the lines; deduct: cash = total - wht, gross-up: cash = total (we bear the tax).
 */
export function settleTotals(st: MockState, companyId: string, type: DocType, body: Part, lineTotals: DocTotals): DocTotals {
  const alloc = sum((body.allocations ?? []).map((a) => money(a.amount, 'settle.invalid_amount')));
  const lines = toSatang(lineTotals.total);
  let total: number, wht: number, cash: number;
  if (type === 'RC') {
    const dep = money(body.header.depositAmount, 'rc.invalid_deposit');
    total = alloc + dep + lines;
    wht = sum((body.allocations ?? []).map((a) => money(a.wht, 'settle.invalid_wht')));
    cash = total - wht;
  } else {
    total = alloc + lines;
    const w = whtOf(st, companyId, body.header, body.lines);
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
  outstanding: (id: string) => number, opts: { partyExempt?: string[]; prior?: Allocation[] } = {}): MockError | undefined {
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
    if (!LIVE.includes(target.status)) return new MockError(422, 'settle.target_not_open', `${label} ไม่อยู่ในสถานะที่ชำระได้`);
    const was = opts.prior?.find((p) => p.targetId === a.targetId);
    const carriedParty = !!was?.partyId && was.partyId === target.header.partyId; // recorded when it was legitimately created / moved
    if (!opts.partyExempt?.includes(a.targetId) && !carriedParty && target.header.partyId !== header.partyId) return new MockError(422, 'settle.party_mismatch', `${label} เป็นของคู่ค้าคนละราย`);
    const amount = money(a.amount, 'settle.invalid_amount');
    if (amount <= 0) return new MockError(422, 'settle.invalid_amount', `จำนวนที่ชำระ ${label} ต้องมากกว่า 0`);
    const out = outstanding(a.targetId);
    if (amount > out && !(was && toSatang(was.amount) === amount)) return new MockError(422, 'settle.over_allocation', `ชำระ ${label} เกินยอดค้างชำระ (ค้างชำระ ${fromSatang(out)} บาท)`);
    const wht = money(a.wht, 'settle.invalid_wht');
    if (wht < 0) return new MockError(422, 'settle.invalid_wht', `ภาษีหัก ณ ที่จ่ายของ ${label} ต้องไม่ติดลบ`);
    if (wht > amount) return new MockError(422, 'rc.wht_exceeds_amount', `ภาษีหัก ณ ที่จ่ายของ ${label} เกินยอดที่ชำระ`);
    if (a.whtTypeCode) { try { whtTypeOf(st, a.whtTypeCode, payeeOf(st, companyId, header.partyId), header.documentDate); } catch (e) { return e as MockError; } }
    if (wht > 0 && type !== 'RC') return new MockError(422, 'settle.wht_not_allowed', 'ภาษีหัก ณ ที่จ่ายของใบสำคัญจ่ายคำนวณจากรายการ ไม่ระบุที่การจัดสรร');
  }
  if (sum(allocs.map((a) => money(a.wht, 'settle.invalid_wht'))) > sum(allocs.map((a) => money(a.amount, 'settle.invalid_amount')))) {
    return new MockError(422, 'rc.wht_exceeds_amount', 'ภาษีหัก ณ ที่จ่ายรวมเกินยอดที่ชำระ');
  }
  return undefined;
}

/** The account the Cash role posts to: the chosen bank account, or the company cash account (1110) when paid in cash. */
export function cashBankId(st: MockState, companyId: string, header: DocHeader): string | undefined {
  if (header.paymentMethod === 'cash') return st.bankAccounts.find((b) => b.companyId === companyId && b.accountCode === '1110')?.id ?? header.bankAccountId;
  return header.bankAccountId;
}

/** Rules about the money that moves, not the open items: bank account of this company, no negative deposit, no input VAT on a voucher line, no negative cash. */
export function payError(st: MockState, companyId: string, type: DocType, body: Part): MockError | undefined {
  if (!SETTLES[type]) return undefined;
  const h = body.header;
  if (h.bankAccountId && !st.bankAccounts.some((b) => b.id === h.bankAccountId && b.companyId === companyId)) return new MockError(422, 'pay.invalid_bank_account', 'บัญชีธนาคารที่เลือกไม่ใช่ของบริษัทนี้');
  if (type === 'RC' && money(h.depositAmount, 'rc.invalid_deposit') < 0) return new MockError(422, 'rc.invalid_deposit', 'เงินรับล่วงหน้าต้องไม่ติดลบ');
  if (type === 'PV' && body.lines.some((l) => l.taxCode !== 'EX')) {
    return new MockError(422, 'pv.input_vat_needs_bill', 'ใบสำคัญจ่ายไม่มีภาษีซื้อ ภาษีซื้อต้องบันทึกผ่านใบรับวางบิล (PB) แล้วจึงจ่ายชำระ');
  }
  if (toSatang(settleTotals(st, companyId, type, body, computeDoc(body.lines, !!h.priceIncludesVat, vatOf(st, companyId)).totals).cash!) < 0) return new MockError(422, 'pay.negative_cash', 'ยอดเงินที่รับ/จ่ายสุทธิติดลบ ตรวจจำนวนเงินและภาษีหัก ณ ที่จ่าย');
  return undefined;
}

/** Every command-time rule of an RC / PV, first violation wins. */
export const settleProblem = (st: MockState, companyId: string, type: DocType, body: Part, outstanding: (id: string) => number, opts: { partyExempt?: string[]; prior?: Allocation[] } = {}) =>
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
  const whtLines: WhtLine[] | undefined = type === 'PV' ? whtOf(st, companyId, body.header, body.lines).lines : undefined;
  return {
    ...(whtLines?.length ? { whtLines } : {}),
    allocation: {
      allocated: fromSatang(allocated), unallocated: type === 'RC' ? fromSatang(money(body.header.depositAmount, 'rc.invalid_deposit')) : '0.00',
      suggestedWht: type === 'RC' ? suggestWht(st, companyId, body.header, body.allocations ?? []) : [],
    },
  };
}
