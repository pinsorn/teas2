import { LIVE } from '@/domain/doc-types';
import type { ReportModel, ReportRow } from '@/domain/reports';
import type { MockState } from '../../store';
import { companyEntries } from '../ledger';
import { MockError } from '../log';
import { fromSatang, toSatang } from '../money';
import { resolvedBankId } from '../settlement';

export interface BankRecParams { account: string; to: string }
const day = (iso: string, by: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + by * 86_400_000).toISOString().slice(0, 10);

/** Bank reconciliation of one bank account at `to` (A.8), from the stored matches, lines and journals only:
 *    difference = statement closing - (GL balance - deposits in transit + outstanding payments + unmatched net)
 *  - GL balance: every journal entry of the company on the account's GL code dated <= to (documents, fee / inline journals, the opening balance).
 *  - Deposits in transit / outstanding payments: what each live receipt / voucher of THIS account (the FN1 rule) put on the GL by `to`, less what its matches on lines dated <= to took.
 *  - Unmatched net: statement lines <= to still unmatched or ignored (the bank has them, the books do not).
 *  - Statement closing: the stored balance of the last line <= to.
 *  The tie-out row is the same difference, not forced to zero: a missing opening balance or a broken journal shows as the figure. Nothing here re-derives a document figure: the journal is what posted. */
export function bankReconciliation(st: MockState, companyId: string, p: BankRecParams): ReportModel {
  const bank = st.bankAccounts.find((b) => b.id === p.account && b.companyId === companyId);
  if (!bank) throw new MockError(404, 'record.not_found', 'ไม่พบข้อมูลนี้');
  const code = bank.accountCode, to = p.to;

  let gl = 0;
  for (const e of companyEntries(st, companyId)) if (e.date <= to) for (const g of e.lines) if (g.accountCode === code) gl += toSatang(g.debit) - toSatang(g.credit);

  // journal side: each live RC / PV of the account, its GL effect up to `to` (the journal is the source), less its matched shares
  const matchedBy = new Map<string, number>(); // docId -> Σ shares on lines <= to
  for (const l of st.bankLines) if (l.companyId === companyId && l.accountId === bank.id && l.date <= to) for (const m of l.matches ?? []) matchedBy.set(m.docId, (matchedBy.get(m.docId) ?? 0) + toSatang(m.amount));
  const transit: { row: ReportRow; sat: number }[] = [], outstanding: { row: ReportRow; sat: number }[] = [];
  for (const d of st.docs) {
    if (d.companyId !== companyId || (d.type !== 'RC' && d.type !== 'PV') || !LIVE.includes(d.status) || resolvedBankId(st, companyId, d.type, d.header) !== bank.id) continue;
    const j = st.journals.find((x) => x.docId === d.id);
    const effect = (j?.preview.entries ?? []).filter((e) => e.date <= to).reduce((n, e) => n + e.lines.filter((g) => g.accountCode === code).reduce((x, g) => x + toSatang(g.debit) - toSatang(g.credit), 0), 0);
    const left = effect - (d.type === 'RC' ? 1 : -1) * (matchedBy.get(d.id) ?? 0);
    if (left === 0) continue;
    const row: ReportRow = { level: 1, kind: 'row', cells: { item: `${d.type} ${d.number ?? d.id}${d.party?.name ? ` · ${d.party.name}` : ''}`, date: d.header.documentDate, amount: fromSatang(Math.abs(left)) } };
    (left > 0 ? transit : outstanding).push({ row, sat: Math.abs(left) });
  }
  const byDate = (a: { row: ReportRow }, b: { row: ReportRow }) => a.row.cells.date.localeCompare(b.row.cells.date) || a.row.cells.item.localeCompare(b.row.cells.item);
  transit.sort(byDate); outstanding.sort(byDate);

  const lines = st.bankLines.filter((l) => l.companyId === companyId && l.accountId === bank.id && l.date <= to).sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  const first = st.bankImports.filter((i) => i.companyId === companyId && i.accountId === bank.id).sort((a, b) => a.from.localeCompare(b.from))[0];
  const closing = lines.length ? toSatang(lines[lines.length - 1].balance) : first && day(first.from, -1) <= to ? toSatang(first.opening) : 0;
  const open = lines.filter((l) => l.status === 'unmatched' || l.status === 'ignored');
  const unmatched = open.reduce((n, l) => n + toSatang(l.amount), 0);

  const dit = transit.reduce((n, x) => n + x.sat, 0), op = outstanding.reduce((n, x) => n + x.sat, 0);
  const adjustedBank = closing + dit - op, adjustedBook = gl + unmatched;
  const sum = (kind: ReportRow['kind'], item: string, sat: number, level: ReportRow['level'] = 0): ReportRow => ({ level, kind, cells: { item, amount: fromSatang(sat) } });
  const group = (item: string): ReportRow => ({ level: 0, kind: 'group', cells: { item } });
  const rows: ReportRow[] = [
    group('ฝั่งรายการเดินบัญชี (statement)'), sum('row', 'ยอดคงเหลือตาม statement', closing, 1),
    group('บวก: เงินรับระหว่างทาง (ใบเสร็จที่ยังไม่เข้า statement)'), ...transit.map((x) => x.row), sum('subtotal', 'รวมเงินรับระหว่างทาง', dit, 1),
    group('หัก: เงินจ่ายที่ยังไม่ออก statement (ใบสำคัญจ่าย)'), ...outstanding.map((x) => x.row), sum('subtotal', 'รวมเงินจ่ายที่ยังไม่ออก statement', op, 1),
    sum('total', 'ยอดตาม statement ปรับปรุงแล้ว', adjustedBank),
    group('ฝั่งบัญชี (GL)'), sum('row', 'ยอดตามบัญชีแยกประเภท (GL)', gl, 1),
    group('บวก: รายการ statement ที่ยังไม่ได้ลงบัญชี (ยังไม่ได้จับคู่)'),
    ...open.map((l): ReportRow => ({ level: 1, kind: 'row', cells: { item: `${l.description}${l.status === 'ignored' ? ' (ข้าม)' : ''}`, date: l.date, amount: l.amount }, href: `/finance/bank-accounts/${bank.id}?line=${l.id}` })),
    sum('subtotal', 'รวมรายการ statement ที่ยังไม่ได้ลงบัญชี', unmatched, 1),
    sum('total', 'ยอดตามบัญชีปรับปรุงแล้ว', adjustedBook),
  ];
  return {
    kind: 'bank-reconciliation', titleKey: 'reports.bankRec.title', asOf: to, params: { account: p.account, to },
    columns: [
      { key: 'item', labelKey: 'reports.bankRec.item', kind: 'text' }, { key: 'date', labelKey: 'reports.bankRec.date', kind: 'date' },
      { key: 'amount', labelKey: 'reports.bankRec.amount', kind: 'money', align: 'end' },
    ],
    rows,
    tieOuts: [{ labelKey: 'reports.bankRec.tie', left: fromSatang(adjustedBank), right: fromSatang(adjustedBook), diff: fromSatang(adjustedBank - adjustedBook) }],
    notes: [bank.nameTh],
  };
}
