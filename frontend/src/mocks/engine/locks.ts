import { LIVE } from '@/domain/doc-types';
import type { BankMatch, DocHeader, DocStatus, DocType, Lock } from '@/domain/types';
import { formatDateBE, formatMoney } from '@/lib/format';
import type { MockState } from '../store';
import { MockError } from './log';
import { periodLock } from './periods';
import { fromSatang, toSatang } from './money';
import { resolvedBankId } from './settlement';

/** The locks a document READS with (single derivation: the doc GET handler and the fixture predicates both call this).
 *  Stored locks (filing, settlement) plus the period lock and the reconciliation lock, derived here and never stored. TX1 adds the filing lock. */
export function derivedLocks(st: MockState, d: { id?: string; locks: Lock[]; companyId: string; status: DocStatus; header: { documentDate: string } }): Lock[] {
  const live = LIVE.includes(d.status);
  const p = live ? periodLock(st, d.companyId, d.header.documentDate) : undefined;
  const r = live && d.id ? reconciliationLock(st, d.id) : undefined;
  return [...d.locks, ...(r ? [r] : []), ...(p ? [p] : [])];
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

