import type { Doc, DocType, JournalEntryPreview, JournalLinePreview, JournalPreview } from '@/domain/types';
import type { MockState } from '../store';
import { fromSatang, toSatang } from './money';
import { MockError } from './log';
import { type AccountingRole, type PostingContext, resolveRole } from './posting';
import { computeDoc } from './vat';

export interface Totals { net: number; vat: number; total: number; wht: number }
/** [role, debit, credit, context additions] in satang; the account behind each role comes from the posting profile (SP0 §5.5). */
export type RolePosting = [AccountingRole, number, number, Partial<PostingContext>?][];
type Rows = (t: Totals, d: Doc, st: MockState) => RolePosting;

/** One row per document line for the net side so an item / category rule can pick that line's account (rows with the same account merge again). */
const netRows = (d: Doc, role: AccountingRole, side: 'Dr' | 'Cr'): RolePosting =>
  computeDoc(d.lines, !!d.header.priceIncludesVat).lines.map((r, i): RolePosting[number] => {
    const n = toSatang(r.net);
    return [role, side === 'Dr' ? n : 0, side === 'Cr' ? n : 0, { itemId: d.lines[i].itemId, dimensions: d.lines[i].dimensions }];
  });

const sales = (role: AccountingRole): Rows => (t, d) => [['AR', t.total, 0], ...netRows(d, role, 'Cr'), ['OutputVat', 0, t.vat]];
const purchase: Rows = (t, d) => [...netRows(d, 'Expense', 'Dr'), ['InputVat', t.vat, 0], ['AP', 0, t.total]];
const mirror = (r: Rows): Rows => (t, d, st) => r(t, d, st).map(([role, dr, cr, c]) => [role, cr, dr, c] as RolePosting[number]);

export const POST: Partial<Record<DocType, Rows>> = {
  TI: sales('Revenue'), IV: sales('Revenue'), DN: sales('Revenue'), CN: mirror(sales('SalesReturn')),
  PB: purchase, PDN: purchase, PCN: mirror(purchase),
  RC: (t) => [['Cash', t.total - t.wht, 0], ['WhtReceivable', t.wht, 0], ['AR', 0, t.total]], // cash received + WHT = total cleared from AR (F5: allocation-aware)
  PV: (t) => [['AP', t.total, 0], ['Cash', 0, t.total]],
};

/** Exact mirror of an entry: debit and credit swapped on every line. */
export const reversalOf = (e: JournalEntryPreview, date: string): JournalEntryPreview => ({
  date, kind: 'reversal',
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
  const t: Totals = { net: toSatang(doc.totals.net), vat: toSatang(doc.totals.vat), total: toSatang(doc.totals.total), wht: toSatang(doc.totals.wht ?? '0.00') };
  const acc = new Map<string, { code: string; name: string; rule: string; net: number; party?: string; dims?: Record<string, string> }>();
  for (const [role, dr, cr, extra] of post(t, doc, st)) {
    const r = resolveRole(st, role, { companyId, docType: doc.type, ...extra });
    const dims = { ...doc.header.dimensions, ...extra?.dimensions };
    const party = (role === 'AR' || role === 'AP') && partyName ? partyName : undefined;
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
  const original: JournalEntryPreview = { date: doc.header.documentDate, kind: 'original', lines };
  const entries = [original];
  if (doc.status === 'cancelled' || doc.status === 'replaced') entries.push(reversalOf(original, doc.cancel?.at.slice(0, 10) ?? doc.header.documentDate));
  return { entries };
}
