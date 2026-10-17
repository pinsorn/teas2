import { LIVE } from '@/domain/doc-types';
import type { BankMatch, DocHeader, DocLine, DocOpening, DocStatus, DocType, Lock } from '@/domain/types';
import { formatDateBE, formatMoney } from '@/lib/format';
import type { MockState } from '../store';
import { MockError } from './log';
import { periodLock } from './periods';
import { fromSatang, toSatang } from './money';
import { jvLock } from './journal';
import { docEditHref, docViewHref } from '@/descriptors';
import { assetLock, refuseObAssets } from './assets';
import { itemsOf, plainOpening } from './opening';
import { scheduleLock } from './schedules';
import { resolvedBankId } from './settlement';
import { filingLock } from './filings';

/** The locks a document READS with (single derivation: the doc GET handler and the fixture predicates both call this).
 *  Stored locks (filing, settlement) plus the period lock and the reconciliation lock, derived here and never stored. */
export function derivedLocks(st: MockState, d: { id?: string; type?: DocType; locks: Lock[]; companyId: string; status: DocStatus; header: DocHeader }): Lock[] {
  const live = LIVE.includes(d.status);
  const p = live && d.type !== 'OB' ? periodLock(st, d.companyId, d.header.documentDate) : undefined; // an opening balance DEFINES the opening: its month being closed is the normal case (D-10 exemption)
  const r = live && d.id ? reconciliationLock(st, d.id) : undefined;
  const s = live && d.id ? settlementLock(st, d.id) : undefined;
  const v = live ? jvLock(st, d) : undefined; // AC1: a reversed JV, and a reversal, are final
  const sc = live ? scheduleLock(st, d) : undefined; // AC4: a live amortisation run on one of its lines
  const o = live && d.id && d.type === 'OB' && !d.header.obBatchId ? obLock(st, d.id) : undefined; // AC3: an opening item already settled or matched
  const fa = live ? assetLock(st, d) : undefined; // AC5: a live fixed asset made from this bill / voucher / opening batch
  const fl = live ? filingLock(st, d) : undefined; // TX1: a document a finalized ภ.พ.30 took (derived from the snapshot's list)
  return [...(s ? d.locks.filter((l) => l.kind !== 'settlement') : d.locks), ...(r ? [r] : []), ...(s ? [s] : []), ...(v ? [v] : []), ...(sc ? [sc] : []), ...(fa ? [fa] : []), ...(fl ? [fl] : []), ...(o ? [o] : []), ...(p && !v ? [p] : [])];
}

/** The cash an RC / PV moves (satang): `totals.cash`, or total - WHT for a document stored without it. */
export const docCash = (d: { totals: { total: string; wht?: string; cash?: string } }): number =>
  toSatang(d.totals.cash ?? fromSatang(toSatang(d.totals.total) - toSatang(d.totals.wht ?? '0.00')));

/** Every bank line (any account of the company's state) a document is matched on, with its match record. */
export const matchesOf = (st: MockState, docId: string): { line: MockState['bankLines'][number]; m: BankMatch }[] =>
  st.bankLines.flatMap((line) => (line.matches ?? []).filter((m) => m.docId === docId).map((m) => ({ line, m })));

/** SP0 7.5: a document matched to a bank line reads with the reconciliation lock; the exit goes to that line. Derived at read, never stored. */
export function reconciliationLock(st: MockState, docId: string): Lock | undefined {
  const ms = matchesOf(st, docId).sort((a, b) => a.line.date.localeCompare(b.line.date) || a.line.id.localeCompare(b.line.id));
  if (!ms.length) return undefined;
  const { line } = ms[0];
  const more = ms.length > 1 ? ` และอีก ${ms.length - 1} รายการ` : '';
  return { kind: 'reconciliation', reason: `จับคู่กับรายการเดินบัญชี ${formatDateBE(line.date)} ${formatMoney(line.amount.replace('-', ''))} แล้ว${more}`, exits: ['ยกเลิกการจับคู่'], href: `/finance/bank-accounts/${line.accountId}?line=${line.id}` };
}

/** Ruling 2: while a document is matched it cannot be cancelled or reissued (no `next`), nor revised in a way that changes its cash, bank account or date (`next` = what the revision would make it).
 *  Compared with the figures frozen in the match; any other header edit stays free. */
export function refuseReconciled(st: MockState, d: { id: string; type: DocType; companyId: string; header: DocHeader; totals: { total: string; wht?: string; cash?: string } },
  next?: { header: DocHeader; totals: { total: string; wht?: string; cash?: string } }): void {
  const lock = reconciliationLock(st, d.id);
  if (!lock) return;
  if (next) {
    const m = matchesOf(st, d.id)[0].m;
    const same = docCash(next) === toSatang(m.docCash) && resolvedBankId(st, d.companyId, d.type, next.header) === m.accountId && next.header.documentDate === m.docDate;
    if (same) return;
  }
  throw new MockError(409, 'doc.reconciled', `${lock.reason} — ${next ? 'แก้ไขยอดเงิน บัญชี หรือวันที่ไม่ได้' : 'ยกเลิกหรือออกใหม่ไม่ได้'} ทางออก: ยกเลิกการจับคู่ที่รายการเดินบัญชีก่อน`);
}

/** AC3 ruling 3: an opening-balance batch whose open item an RC / PV settled (or a CN / DN adjusted), or whose in-transit item a bank line matched, is locked; the exit is to cancel that RC / PV or unmatch. Derived at read, never stored. */
function itemLock(st: MockState, batchId: string): Lock | undefined {
  const items = itemsOf(st, batchId).filter((i) => LIVE.includes(i.status));
  const link = (i: { id: string }) => st.links.find((l) => l.active && l.to === i.id && (l.kind === 'settles' || l.kind === 'adjusts'));
  const used = items.find((i) => link(i));
  if (used) {
    const l = link(used)!, from = st.docs.find((x) => x.id === l.from);
    return { kind: 'settlement', reason: `ยอดยกมา ${used.number} ถูกชำระ/ปรับปรุงด้วย ${from?.number ?? l.from} แล้ว`, exits: [`ยกเลิก ${from?.number ?? 'ใบเสร็จ/ใบสำคัญจ่าย'} ที่ชำระยอดยกมาก่อน`], ...(from && docViewHref(from.type, from.id) ? { href: docViewHref(from.type, from.id) } : {}) };
  }
  const hit = items.map((i) => matchesOf(st, i.id)[0]).find((x) => x);
  if (hit) return { kind: 'reconciliation', reason: `รายการระหว่างทางยกมาจับคู่กับรายการเดินบัญชี ${formatDateBE(hit.line.date)} ${formatMoney(hit.line.amount.replace('-', ''))} แล้ว`, exits: ['ยกเลิกการจับคู่'], href: `/finance/bank-accounts/${hit.line.accountId}?line=${hit.line.id}` };
  return undefined;
}

/** F2: the bank accounts this batch opened that now have an imported statement. The statement runs on from the go-live the batch set, so the opening it fixed (that account's bank step, the cut-off) cannot move or go; there is no way to un-import. */
export const importedBanks = (st: MockState, d: { id: string; companyId?: string; opening?: DocOpening }): string[] =>
  (d.opening?.bank ?? []).map((b) => b.accountId).filter((a) => st.bankImports.some((i) => i.accountId === a && (!d.companyId || i.companyId === d.companyId)) || st.bankLines.some((l) => l.accountId === a && (l.matches?.length ?? 0) > 0));
const importLock = (st: MockState, d: { id: string; opening?: DocOpening }): Lock | undefined => {
  const doc = st.docs.find((x) => x.id === d.id), banks = importedBanks(st, { id: d.id, companyId: doc?.companyId, opening: d.opening });
  return banks.length ? { kind: 'reconciliation', reason: `บัญชีธนาคารที่ยอดยกมานี้เปิดไว้ (${banks.map((a) => st.bankAccounts.find((b) => b.id === a)?.nameTh ?? a).join(', ')}) มี statement นำเข้าแล้ว`, exits: ['แก้ไขยอดยกมา (ขั้นตอนอื่น รายการอื่น หรือบัญชีอื่นแก้ได้ แต่ยอด statement ของบัญชีนี้และวันตัดยอดต้องคงเดิม)'], href: docEditHref('OB', d.id) } : undefined;
};
export const obLock = (st: MockState, batchId: string): Lock | undefined => itemLock(st, batchId) ?? importLock(st, { id: batchId, opening: st.docs.find((x) => x.id === batchId)?.opening });

/** AC3 ruling 3: while an item is settled or matched the batch cannot be cancelled, nor revised in its money (steps, trial balance, cut-off); `next` = what the revision would make it. A notes-only edit stays free.
 *  F2: an imported statement on an account it opened locks only that account's bank step and the cut-off (and cancel); everything else stays revisable. */
export function refuseObLocked(st: MockState, d: { id: string; header: DocHeader; lines: DocLine[]; opening?: DocOpening },
  next?: { header: DocHeader; lines: DocLine[]; opening?: DocOpening }): void {
  refuseObAssets(st, d, next); // AC5: a row a live fixed asset stands on, and the cut-off, stay as they are
  const lock = itemLock(st, d.id);
  if (!lock) {
    const il = importLock(st, d);
    if (!il) return;
    const bankKey = (x: { opening?: DocOpening }, a: string) => JSON.stringify((plainOpening(x.opening) as { bank: unknown[] } | undefined)?.bank.filter((b) => (b as { accountId: string }).accountId === a) ?? []);
    if (next && next.header.documentDate === d.header.documentDate && importedBanks(st, d).every((a) => bankKey(next, a) === bankKey(d, a))) return;
    throw new MockError(409, 'ob.locked', `${il.reason} — ${next ? 'แก้ไขยอด statement ของบัญชีนี้หรือวันตัดยอดไม่ได้' : 'ยกเลิกยอดยกมาไม่ได้'} ทางออก: ${il.exits[0]}`);
  }
  const key = (x: { header: DocHeader; lines: DocLine[]; opening?: DocOpening }) => JSON.stringify([x.header.documentDate, plainOpening(x.opening) ?? null, x.lines.map((l) => [l.accountCode, toSatang(l.debit ?? '0.00'), toSatang(l.credit ?? '0.00'), l.partyId ?? ''])]);
  if (next && key(next) === key(d)) return;
  throw new MockError(409, 'ob.locked', `${lock.reason} — ${next ? 'แก้ไขยอดยกมาไม่ได้' : 'ยกเลิกยอดยกมาไม่ได้'} ทางออก: ${lock.exits[0]}`);
}

/** FN3: the posted settlement records a document is a leg of (a deposit / prepayment source, a target, a netting side). Reads the store only, so the lock never depends on the settlement engine. */
export const settlementsOf = (st: MockState, docId: string) =>
  st.settlements.filter((s) => s.status === 'posted' && (s.sources.some((l) => l.docId === docId) || s.targets.some((l) => l.docId === docId)));

/** The company's tolerance for a difference role (satang). A bank fee is limited like a small write-off. [SP-R] */
export function toleranceOf(st: MockState, companyId: string, role: string): number {
  const t = st.settlementTolerance.find((x) => x.companyId === companyId);
  return toSatang(role === 'RoundingDifference' ? t?.rounding ?? '0.00' : t?.smallWriteOff ?? '0.00');
}

/** Ruling 1 (FN3): what the live settlements already took from one target in one difference role (satang). A record with several targets charges its FULL difference to each. */
export const differenceUsed = (st: MockState, docId: string, role: string): number =>
  st.settlements.filter((s) => s.status === 'posted' && s.difference?.role === role && s.targets.some((l) => l.docId === docId)).reduce((n, s) => n + toSatang(s.difference!.amount), 0);

/** What posted settlements took FROM a deposit / prepayment (satang). */
export const appliedOf = (st: MockState, docId: string): number =>
  st.settlements.filter((s) => s.status === 'posted').reduce((n, s) => n + s.sources.filter((l) => l.docId === docId).reduce((m, l) => m + toSatang(l.amount), 0), 0);

/** SP0 7.5: a document that is a leg of a posted settlement reads with the settlement lock; the exit goes to that settlement (reverse it). Derived at read, never stored. */
export function settlementLock(st: MockState, docId: string): Lock | undefined {
  const ss = settlementsOf(st, docId).sort((a, b) => a.id.localeCompare(b.id));
  if (!ss.length) return undefined;
  const more = ss.length > 1 ? ` และอีก ${ss.length - 1} รายการ` : '';
  return { kind: 'settlement', reason: `ใช้ในรายการหักกลบ/ใช้เงินมัดจำ ${ss[0].id.toUpperCase()} แล้ว${more}`, exits: ['ย้อนรายการหักกลบ'], href: `/finance/settlements/${ss[0].id}` };
}

/** Ruling 1 (FN3): while a document is a leg of a posted settlement it cannot be cancelled or reissued (no `next`), nor revised in a way that changes its cash, deposit, party, date or total (`next` = what the revision would make it).
 *  Any other edit stays free. Exit: reverse the settlement. */
export function refuseSettled(st: MockState, d: { id: string; header: DocHeader; totals: { total: string; wht?: string; cash?: string } },
  next?: { header: DocHeader; totals: { total: string; wht?: string; cash?: string } }): void {
  const lock = settlementLock(st, d.id);
  if (!lock) return;
  if (next) {
    const dep = (h: DocHeader) => toSatang(h.depositAmount ?? '0.00');
    const same = docCash(next) === docCash(d) && dep(next.header) === dep(d.header) && next.header.partyId === d.header.partyId && next.header.documentDate === d.header.documentDate && toSatang(next.totals.total) === toSatang(d.totals.total);
    if (same) return;
  }
  throw new MockError(409, 'doc.settled', `${lock.reason} — ${next ? 'แก้ไขยอดเงิน เงินมัดจำ คู่ค้า หรือวันที่ไม่ได้' : 'ยกเลิกหรือออกใหม่ไม่ได้'} ทางออก: ย้อนรายการหักกลบก่อน`);
}
