import type { FilingForm, TaxPaymentState } from '@/domain/filings';
import type { BankJournal } from '@/domain/types';
import type { MockState } from '../../store';
import { fromSatang, toSatang } from '../money';
import { resolveRole } from '../posting';
import { controlExit } from '../reconcile';
import { type Filing, boxOf, pp30Net } from './pp30';

/** TX2c: paying a finalized return to the Revenue Department. The payment is a bank journal of kind 'tax' (Dr the return's payable [+ other legs] / Cr the bank) with a frozen reference to the return; "paid" is derived from it, the filing snapshot is never touched. */
const sat = (m: string | undefined) => toSatang(m ?? '0.00');

/** The tax a finalized return asks to be paid (satang): ภ.พ.30 the net payable (max(5 - 7 - 10, 0), from the stored boxes), ภ.ง.ด. box "tax", ภ.พ.36 box "vat". */
export function taxDueOf(f: Filing): number {
  return f.form === 'PP30' ? Math.max(pp30Net(f.boxes), 0) : boxOf(f.boxes, f.form === 'PP36' ? 'vat' : 'tax');
}
/** The payable a payment of this return clears: VatPayable (PP30), Pnd36VatPayable (PP36), WhtPayable keyed by the form (PND*). */
export function payableAccountOf(st: MockState, f: Filing): string {
  const ctx = { companyId: f.companyId, docType: 'PV' as const };
  if (f.form === 'PP30') return resolveRole(st, 'VatPayable', ctx).code;
  if (f.form === 'PP36') return resolveRole(st, 'Pnd36VatPayable', ctx).code;
  return resolveRole(st, 'WhtPayable', { ...ctx, whtForm: f.form as 'PND2' | 'PND3' | 'PND53' | 'PND54' }).code;
}
/** Where a form's page lives (the same two-branch href the filing lock uses). */
export const filingHref = (form: FilingForm, period: string) => (form === 'PP30' ? `/tax/vat?period=${period}` : form === 'PND50' || form === 'PND51' ? `/tax/cit?tab=${form.toLowerCase()}&period=${period}` : `/tax/wht?tab=${form.toLowerCase()}&period=${period}`);
export const inForceTax = (j: BankJournal) => j.kind === 'tax' && j.entries[j.entries.length - 1]?.kind !== 'reversal';
/** The in-force payment of a return (at most one, invariant T3). */
export const livePaymentOf = (st: MockState, f: Filing): BankJournal | undefined =>
  st.bankJournals.find((j) => j.companyId === f.companyId && inForceTax(j) && j.filing?.form === f.form && j.filing.period === f.period);

/** Satang of the legs other than the payable (first) and the bank (last): the fee / เงินเพิ่ม typed from the RD receipt. */
const extrasOf = (j: BankJournal) => j.entries[0].lines.slice(1, -1).reduce((n, l) => n + sat(l.debit), 0);
export function paymentStateOf(st: MockState, f: Filing): TaxPaymentState {
  const due = taxDueOf(f), j = livePaymentOf(st, f);
  if (j) return { due: fromSatang(due), status: 'paid', paidOn: j.entries[0].date, journalId: j.id, ...(j.lineId ? { lineId: j.lineId } : {}), accountId: j.accountId, ...(extrasOf(j) ? { extras: fromSatang(extrasOf(j)) } : {}) };
  return { due: fromSatang(due), status: due === 0 ? 'nothing_due' : 'unpaid' };
}

/** T1-T4 (TX2c): a payment journal is exactly the payment its return gives, one live per return, and its line agrees. */
export function paymentInvariants(st: MockState): string[] {
  const out: string[] = [], live = new Map<string, number>();
  for (const j of st.bankJournals) {
    if (j.kind !== 'tax') continue;
    const w = `tax payment ${j.id}`, ref = j.filing;
    const f = ref && st.filings.find((x) => x.companyId === j.companyId && x.form === ref.form && x.period === ref.period);
    if (!ref || !f) { out.push(`${w}: the return it pays is missing`); continue; }
    const key = `${j.companyId}|${ref.form}|${ref.period}`, on = inForceTax(j);
    if (on) live.set(key, (live.get(key) ?? 0) + 1);
    const e = j.entries[0], bank = st.bankAccounts.find((b) => b.id === j.accountId && b.companyId === j.companyId)?.accountCode;
    if (e?.kind !== 'original' || (j.entries.length !== 1 && !(j.entries.length === 2 && j.entries[1].kind === 'reversal'))) { out.push(`${w}: its entries are not one payment (and its reversal)`); continue; }
    if (j.entries.length === 2) {
      const mirror = (a: typeof e.lines) => JSON.stringify(a.map((l) => [l.accountCode, l.credit, l.debit]));
      if (mirror(e.lines) !== JSON.stringify(j.entries[1].lines.map((l) => [l.accountCode, l.debit, l.credit]))) out.push(`${w}: its reversal is not the mirror of the payment`);
    }
    const ls = e.lines, first = ls[0], last = ls[ls.length - 1], mid = ls.slice(1, -1);
    if (ls.length < 2 || first.accountCode !== payableAccountOf(st, f) || first.debit !== ref.amount || sat(first.credit) !== 0) out.push(`${w}: its first line is not the ${ref.amount} paid on the return's payable ${payableAccountOf(st, f)}`);
    if (ls.length >= 2 && (last.accountCode !== bank || sat(last.debit) !== 0 || sat(last.credit) !== ls.slice(0, -1).reduce((n, l) => n + sat(l.debit), 0))) out.push(`${w}: its last line is not the bank credit of everything debited`);
    for (const m of mid) if (sat(m.credit) !== 0 || sat(m.debit) <= 0 || controlExit(st, j.companyId, m.accountCode) !== undefined) out.push(`${w}: ${m.accountCode} is not a debit to an account free for a payment`);
    if (sat(ref.amount) !== taxDueOf(f) || taxDueOf(f) <= 0) out.push(`${w}: it pays ${ref.amount} but the ${ref.form} ${ref.period} tax is ${fromSatang(taxDueOf(f))}`);
    const l = st.bankLines.find((x) => x.id === j.lineId && x.companyId === j.companyId);
    if (!l) { out.push(`${w}: its line is missing`); continue; }
    if (on) {
      if (l.status !== 'posted' || l.journalId !== j.id) out.push(`${w}: its line ${l.id} is ${l.status}, not posted to this payment`);
      if (e.date !== l.date || (ls.length >= 2 && sat(l.amount) !== -sat(last.credit))) out.push(`${w}: its line ${l.id} (${l.date}, ${l.amount}) is not the date and amount it paid`);
    } else if (l.journalId === j.id) out.push(`${w}: reversed but its line ${l.id} still points to it`);
  }
  for (const [k, n] of live) if (n > 1) out.push(`tax payment ${k.split('|').slice(1).join(' ')} (${k.split('|')[0]}): two live payments`);
  return out;
}
