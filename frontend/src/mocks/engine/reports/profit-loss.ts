import { GROUP_OF } from '@/records/accounts';
import type { MockState } from '../../store';
import { companyEntries } from '../ledger';
import { toSatang } from '../money';

// The ONE place a fiscal year's profit is added up (I12): the year-end closing entry (close.ts), the ภ.ง.ด.50 / 51 (filings/cit.ts) and the P&L report (RP1, to come) all read it. The fiscal year is the calendar year (fiscalYearStartMonth 1).

/** Σ debit - Σ credit (satang) per account of the entries dated in `year` (up to `through`); `closing` false leaves the year-end entries out (what they close). */
export function balances(st: MockState, companyId: string, year: number, closing: boolean, through = `${year}-12-31`): Map<string, number> {
  const m = new Map<string, number>();
  for (const e of companyEntries(st, companyId, closing)) if (e.date.startsWith(`${year}-`) && e.date <= through) for (const l of e.lines) m.set(l.accountCode, (m.get(l.accountCode) ?? 0) + toSatang(l.debit) - toSatang(l.credit));
  return m;
}
const isPl = (st: MockState, companyId: string, code: string) => { const a = st.accounts.find((x) => x.companyId === companyId && x.code === code); return !!a && ['revenue', 'expense'].includes(GROUP_OF[a.class]); };
/** The revenue / expense accounts with a balance, by code. */
export const plOf = (st: MockState, companyId: string, m: Map<string, number>): [string, number][] => [...m].filter(([c, v]) => v !== 0 && isPl(st, companyId, c)).sort(([a], [b]) => a.localeCompare(b));
/** The year's profit in satang (negative = loss): Σ revenue - Σ expense, closing entries left out, optionally only up to `through` (the half year of a ภ.ง.ด.51). */
export const netProfit = (st: MockState, companyId: string, year: number, through?: string): number => -plOf(st, companyId, balances(st, companyId, year, false, through)).reduce((n, [, v]) => n + v, 0);
