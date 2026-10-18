import type { ReportRow } from '@/domain/reports';
import { DBD_LINES, type AccountClass, type AccountGroup } from '@/records/accounts';
import th from '@/messages/th.json';
import { fromSatang } from '../money';
import { MockError } from '../log';

// How the financial statements are laid out: sections of accounts (by class, or by the DBD line an account is mapped to), each with its subtotal. Pure layout - every figure comes in already summed
// by the engine (profit-loss.ts `rangeBalances` for the P&L and the balance sheet alike).

export const NO_DIM_TH = 'ไม่ระบุ';
export const UNGROUPED_TH = 'ยังไม่จัดกลุ่ม';
export const GROSS_PROFIT_TH = 'กำไรขั้นต้น (รายได้จากการขายและบริการ - ต้นทุนขาย)';
export const NET_PROFIT_TH = 'กำไร (ขาดทุน) สุทธิ';
export const UNCLOSED_TH = 'กำไร (ขาดทุน) ที่ยังไม่ได้ปิดบัญชี';

export const CLASS_TH: Record<AccountClass, string> = {
  'current-asset': 'สินทรัพย์หมุนเวียน', 'non-current-asset': 'สินทรัพย์ไม่หมุนเวียน', 'current-liability': 'หนี้สินหมุนเวียน', 'non-current-liability': 'หนี้สินไม่หมุนเวียน', equity: 'ทุนและกำไรสะสม',
  'sales-revenue': 'รายได้จากการขายและบริการ', 'other-income': 'รายได้อื่น', 'cost-of-sales': 'ต้นทุนขายและบริการ', 'selling-admin-expense': 'ค่าใช้จ่ายในการขายและบริหาร',
  'other-expense': 'ค่าใช้จ่ายอื่น', 'finance-cost': 'ต้นทุนทางการเงิน', 'income-tax': 'ภาษีเงินได้',
};
/** SP0 §5.4 order of the P&L classes. */
export const PL_CLASSES: AccountClass[] = ['sales-revenue', 'other-income', 'cost-of-sales', 'selling-admin-expense', 'other-expense', 'finance-cost', 'income-tax'];

/** One account of a statement: `v` = its amount per column (satang), already on the side the statement shows it (revenue / liability / equity = credit - debit, the rest debit - credit). */
export interface Acct { code: string; name: string; group: AccountGroup; dbdLine?: string; v: number[]; /** A computed row, not an account: no drill-down. */ plain?: true }
export interface Sec { label: string; group: AccountGroup; tag?: 'sales' | 'cogs'; accts: Acct[] }

const dbdText = (k: string) => (th.records.options.dbdLine as Record<string, string>)[k] ?? k;
const idx = (k: string) => DBD_LINES.indexOf(k as never);
const slice = (from: string, to: string) => DBD_LINES.slice(idx(from), idx(to) + 1);
/** The balance-sheet lines of แบบ 2 by the group they belong to, and the P&L lines of format 2.7 by the side they take (revenue-like or expense-like). */
const BS_LINES: Record<'asset' | 'liability' | 'equity', readonly string[]> = {
  asset: slice('bs-cash-and-equivalents', 'bs-held-for-sale-noncurrent'), liability: slice('bs-overdrafts-and-bank-loans-short', 'bs-other-noncurrent-liabilities'), equity: slice('bs-paid-up-capital', 'bs-non-controlling-interests'),
};
const PL_REVENUE_LINES = ['pl-revenue-from-sales-or-services', 'pl-other-income', 'pl-equity-method-share'];
const PL_LINES = DBD_LINES.filter((k) => k.startsWith('pl-'));
const lineGroup = (k: string): AccountGroup | undefined => k.startsWith('pl-') ? (PL_REVENUE_LINES.includes(k) ? 'revenue' : 'expense')
  : (Object.entries(BS_LINES).find(([, ls]) => ls.includes(k))?.[0] as AccountGroup | undefined);

/** Sections by class, in the order given, each holding the accounts of its class. */
export const classSections = (accts: Acct[], classOf: (code: string) => AccountClass, order: AccountClass[]): Sec[] =>
  order.flatMap((c) => {
    const mine = accts.filter((a) => classOf(a.code) === c);
    return mine.length ? [{ label: CLASS_TH[c], group: mine[0].group, ...(c === 'sales-revenue' ? { tag: 'sales' as const } : c === 'cost-of-sales' ? { tag: 'cogs' as const } : {}), accts: mine }] : [];
  });

/** Sections by the DBD line each account is mapped to, in print order. An account with no mapping (or one that points at a line of the other side) is never dropped: it goes to "ยังไม่จัดกลุ่ม", one section per group. */
export function dbdSections(accts: Acct[], kind: 'pl' | 'bs'): Sec[] {
  const lines = kind === 'pl' ? PL_LINES : [...BS_LINES.asset, ...BS_LINES.liability, ...BS_LINES.equity];
  const taken = new Set<Acct>();
  const out: Sec[] = lines.flatMap((k) => {
    const mine = accts.filter((a) => a.dbdLine === k && a.group === lineGroup(k));
    mine.forEach((a) => taken.add(a));
    return mine.length ? [{ label: dbdText(k), group: mine[0].group, ...(k === 'pl-revenue-from-sales-or-services' ? { tag: 'sales' as const } : k === 'pl-cost-of-sales-or-services' ? { tag: 'cogs' as const } : {}), accts: mine }] : [];
  });
  const left = accts.filter((a) => !taken.has(a));
  const groups: AccountGroup[] = kind === 'pl' ? ['revenue', 'expense'] : ['asset', 'liability', 'equity'];
  const TH: Record<AccountGroup, string> = { asset: 'สินทรัพย์', liability: 'หนี้สิน', equity: 'ส่วนของเจ้าของ', revenue: 'รายได้', expense: 'ค่าใช้จ่าย' };
  for (const g of groups) { const mine = left.filter((a) => a.group === g); if (mine.length) out.push({ label: `${UNGROUPED_TH} (${TH[g]})`, group: g, accts: mine }); }
  return out;
}

export const sumV = (vs: number[][], n: number): number[] => Array.from({ length: n }, (_, i) => vs.reduce((a, v) => a + (v[i] ?? 0), 0));
export const secTotal = (s: Sec, n: number) => sumV(s.accts.map((a) => a.v), n);

/** Cells of one row: the amount per column key (blank for a heading). */
export const money = (keys: string[], v?: number[]): Record<string, string> => Object.fromEntries(keys.map((k, i) => [k, v ? fromSatang(v[i]) : '']));
export interface Links { href: (code: string) => string; cell?: (code: string, key: string) => string | undefined }
/** A section as rows: heading, its accounts (each linking to the GL), the subtotal. */
export function sectionRows(s: Sec, keys: string[], link: Links): ReportRow[] {
  return [
    { level: 0, kind: 'group', cells: { code: '', name: s.label, ...money(keys) } },
    ...s.accts.map((a): ReportRow => {
      const links = link.cell ? Object.fromEntries(keys.flatMap((k) => { const h = link.cell!(a.code, k); return h ? [[k, h]] : []; })) : {};
      return { level: 1, kind: 'row', cells: { code: a.code, name: a.name, ...money(keys, a.v) }, ...(a.plain ? {} : { href: link.href(a.code) }), ...(Object.keys(links).length && !a.plain ? { links } : {}) };
    }),
    { level: 0, kind: 'subtotal', cells: { code: '', name: s.label, ...money(keys, secTotal(s, keys.length)) } },
  ];
}

/** The drill-down to the general ledger: the same range (and the dimension value of a grouped column). */
export function glLink(account: string, o: { from?: string; to?: string; dimension?: string }): string {
  const q = new URLSearchParams({ tab: 'gl', account });
  if (o.from) q.set('from', o.from);
  if (o.to) q.set('to', o.to);
  if (o.dimension) q.set('dimension', o.dimension);
  return `/reports/financial-statements?${q}`;
}

export const badParam = (title: string) => new MockError(422, 'report.bad_param', title);
const REAL = /^\d{4}-\d{2}-\d{2}$/;
export const needDate = (name: string, v: string | undefined): string => {
  if (!v || !REAL.test(v) || !new Date(`${v}T00:00:00Z`).toISOString().startsWith(v)) throw badParam(`วันที่ไม่ถูกต้อง (${name})`);
  return v;
};
