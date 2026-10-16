import type { Doc, DocType, JournalEntryPreview, JournalLinePreview, JournalPreview } from '@/domain/types';
import type { MockState } from '../store';
import { fromSatang, toSatang } from './money';
import { MockError } from './log';
import { type AccountingRole, type PostingContext, resolveRole } from './posting';
import { categoryOf, isRecoverable } from './purchase-vat';
import { cashBankId, whtOf } from './settlement';
import { computeDoc, vatBasisOf, vatOf } from './vat';

export interface Totals { net: number; vat: number; total: number; wht: number; cash: number }
/** [role, debit, credit, context additions] in satang; the account behind each role comes from the posting profile (SP0 §5.5). */
export type RolePosting = [AccountingRole, number, number, (Partial<PostingContext> & { partyName?: string })?][];
type Rows = (t: Totals, d: Doc, st: MockState, companyId: string) => RolePosting;

/** One row per document line for the net side so an item / category rule can pick that line's account (rows with the same account merge again). */
const netRows = (d: Doc, role: AccountingRole, side: 'Dr' | 'Cr', vatRegistered: boolean): RolePosting =>
  computeDoc(d.lines, !!d.header.priceIncludesVat, vatRegistered).lines.map((r, i): RolePosting[number] => {
    const n = toSatang(r.net);
    return [role, side === 'Dr' ? n : 0, side === 'Cr' ? n : 0, { itemId: d.lines[i].itemId, expenseCategory: d.lines[i].expenseCategory, dimensions: d.lines[i].dimensions }];
  });

const sales = (role: AccountingRole): Rows => (t, d, st, co) => [['AR', t.total, 0], ...netRows(d, role, 'Cr', vatOf(st, co)), ['OutputVat', 0, t.vat]];
/** A vendor's invoice (PB / PDN, mirrored for a PCN): per line the net goes to its expense account (a capex category capitalises to its asset class) and its VAT to input VAT when it is
 *  claimable, else to InputVatUnclaimed (cost; on a capex line part of the asset). The VAT is the tax code's whatever OUR company's status (A.4); AP is the gross. */
const purchase: Rows = (t, d, st, co) => {
  const rs = computeDoc(d.lines, !!d.header.priceIncludesVat, true).lines;
  const rows: RolePosting = d.lines.flatMap((l, i): RolePosting => {
    const cat = categoryOf(st, co, l), ctx = { itemId: l.itemId, expenseCategory: cat?.code ?? l.expenseCategory, dimensions: l.dimensions };
    const net = toSatang(rs[i].net), vat = toSatang(rs[i].vat), claim = isRecoverable(st, co, l, d.header.inputVatForfeited);
    // I3: VAT that cannot be claimed is cost; on a capex line the cost is the asset's (TAS 16), elsewhere it is InputVatUnclaimed
    if (cat?.capex) return claim ? [['FixedAsset', net, 0, { ...ctx, assetClass: cat.assetClass }], ['InputVat', vat, 0]] : [['FixedAsset', net + vat, 0, { ...ctx, assetClass: cat.assetClass }]];
    return [['Expense', net, 0, ctx], [claim ? 'InputVat' : 'InputVatUnclaimed', vat, 0]];
  });
  return [...rows, ['AP', 0, t.total]];
};
/** Σ allocation amounts whose target is one of `types` (satang). */
const allocTo = (d: Doc, types: DocType[]) => (d.allocations ?? []).filter((a) => types.includes(a.targetType)).reduce((n, a) => n + toSatang(a.amount), 0);
/** One row per allocation, under the TARGET's party: the AR / AP subledger of each customer / vendor stays right when one document settles several parties. */
const perTarget = (d: Doc, st: MockState, role: 'AR' | 'AP', types: DocType[], side: 'Dr' | 'Cr'): RolePosting =>
  (d.allocations ?? []).filter((a) => types.includes(a.targetType)).map((a): RolePosting[number] => {
    const n = toSatang(a.amount), name = st.docs.find((x) => x.id === a.targetId)?.party?.name;
    return [role, side === 'Dr' ? n : 0, side === 'Cr' ? n : 0, name ? { partyName: name } : undefined];
  });
const mirror = (r: Rows): Rows => (t, d, st, co) => r(t, d, st, co).map(([role, dr, cr, c]) => [role, cr, dr, c] as RolePosting[number]);

export const POST: Partial<Record<DocType, Rows>> = {
  TI: sales('Revenue'), IV: sales('Revenue'), DN: sales('Revenue'), CN: mirror(sales('SalesReturn')),
  PB: purchase, PDN: purchase, PCN: mirror(purchase),
  // RC: cash received + WHT withheld by the customer = what it clears from AR + the deposit remainder + a non-VAT cash bill (net + output VAT)
  RC: (t, d, st, co) => [['Cash', t.cash, 0, { bankAccountId: cashBankId(st, co, d.header) }], ['WhtReceivable', t.wht, 0], ...perTarget(d, st, 'AR', ['TI', 'IV'], 'Cr'),
    ['CustomerDeposit', 0, toSatang(d.header.depositAmount ?? '0.00')], ...netRows(d, 'Revenue', 'Cr', vatOf(st, co)), ['OutputVat', 0, t.vat]],
  // PV: payables cleared + expense lines (+ their input VAT) + the WHT we bear (gross-up) = cash paid + WHT payable per return
  // a voucher's own line is a payment with no tax invoice (EX, D-16): per line its category's expense account, or the asset on a capex category - never input VAT (1170), whoever we are (A.4)
  PV: (t, d, st, companyId) => {
    const w = whtOf(st, companyId, d.header, d.lines, d.allocations); // expense = the part of the tax / gross-up we bear
    const rs = computeDoc(d.lines, !!d.header.priceIncludesVat, vatBasisOf(st, companyId, 'PV')).lines;
    const own = d.lines.flatMap((l, i): RolePosting => {
      const cat = categoryOf(st, companyId, l), ctx = { itemId: l.itemId, expenseCategory: cat?.code ?? l.expenseCategory, dimensions: l.dimensions };
      const cost = toSatang(rs[i].net) + toSatang(rs[i].vat); // a voucher line carries no claimable VAT: any VAT on it is cost
      return [cat?.capex ? ['FixedAsset', cost, 0, { ...ctx, assetClass: cat.assetClass }] : ['Expense', cost, 0, ctx]];
    });
    return [...perTarget(d, st, 'AP', ['PB'], 'Dr'), ['EmployeePayable', allocTo(d, ['EX']), 0], ...own,
      ['WhtExpense', w.expense, 0], ...w.lines.map((l): RolePosting[number] => ['WhtPayable', 0, toSatang(l.tax), { whtForm: l.form }]),
      ['Cash', 0, t.cash, { bankAccountId: cashBankId(st, companyId, d.header) }]];
  },
};

/** Exact mirror of an entry: debit and credit swapped on every line. */
export const reversalOf = (e: JournalEntryPreview, date: string, postedAt?: string): JournalEntryPreview => ({
  date, kind: 'reversal', ...(postedAt ? { postedAt } : {}),
  lines: e.lines.map((l) => ({ ...l, debit: l.credit, credit: l.debit, rule: `${l.rule} (กลับรายการ)` })),
});

/** Posting for the document as it stands: its original entry, plus the reversal when it is cancelled or replaced.
 *  Types without a ledger effect (N-class, JV, ...) return no entries. */
export function ledgerFor(st: MockState, doc: Doc & { companyId?: string }): JournalPreview {
  const post = POST[doc.type];
  if (!post) return { entries: [] };
  const companyId = doc.companyId ?? st.docs.find((d) => d.id === doc.id)?.companyId;
  if (!companyId) throw new MockError(500, 'engine.invariant', 'ledgerFor: document has no company');
  const partyName = doc.party?.name ?? st.parties.find((p) => p.id === doc.header.partyId)?.name;
  const t: Totals = { net: toSatang(doc.totals.net), vat: toSatang(doc.totals.vat), total: toSatang(doc.totals.total), wht: toSatang(doc.totals.wht ?? '0.00'),
    cash: toSatang(doc.totals.cash ?? fromSatang(toSatang(doc.totals.total) - toSatang(doc.totals.wht ?? '0.00'))) };
  const acc = new Map<string, { code: string; name: string; rule: string; net: number; party?: string; dims?: Record<string, string> }>();
  for (const [role, dr, cr, extra] of post(t, doc, st, companyId)) {
    const r = resolveRole(st, role, { companyId, docType: doc.type, ...extra });
    const dims = { ...doc.header.dimensions, ...extra?.dimensions };
    const party = (role === 'AR' || role === 'AP') ? (extra?.partyName ?? partyName) : undefined;
    const key = `${r.code}|${r.rule}|${party ?? ''}|${JSON.stringify(dims)}`;
    const prev = acc.get(key);
    // a negative side (e.g. a CN line with a negative VAT) is posted on the opposite side, never as a negative amount
    acc.set(key, prev ? { ...prev, net: prev.net + dr - cr } : { ...r, net: dr - cr, party, ...(Object.keys(dims).length ? { dims } : {}) });
  }
  const lines: JournalLinePreview[] = [...acc.values()].filter((x) => x.net !== 0).map((x) => ({
    accountCode: x.code, accountName: x.name, debit: fromSatang(Math.max(x.net, 0)), credit: fromSatang(Math.max(-x.net, 0)), rule: x.rule,
    ...(x.party ? { partyName: x.party } : {}), ...(x.dims ? { dimensions: x.dims } : {}),
  }));
  if (!lines.length) return { entries: [] };
  const original: JournalEntryPreview = { date: doc.header.documentDate, kind: 'original', lines, ...(doc.issuedAt ? { postedAt: doc.issuedAt } : {}) };
  const entries = [original];
  if (doc.status === 'cancelled' || doc.status === 'replaced') entries.push(reversalOf(original, doc.cancel?.at.slice(0, 10) ?? doc.header.documentDate, doc.cancel?.at));
  return { entries };
}
