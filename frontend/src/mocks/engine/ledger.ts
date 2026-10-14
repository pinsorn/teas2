import type { Doc, DocType, JournalEntryPreview, JournalPreview } from '@/domain/types';
import type { MockState } from '../store';
import { fromSatang, toSatang } from './money';

const RULE = 'company default';
const ACC = {
  AR: ['1130', 'ลูกหนี้การค้า'], REV: ['4100', 'รายได้จากการขายและบริการ'], OUT: ['2151', 'ภาษีขาย'],
  BANK: ['1120', 'เงินฝากธนาคาร'], WHT: ['1180', 'ภาษีถูกหัก ณ ที่จ่าย'],
  EXP: ['5100', 'ต้นทุนและค่าใช้จ่าย'], IN: ['1170', 'ภาษีซื้อ'], AP: ['2110', 'เจ้าหนี้การค้า'],
} as const;
type Acc = keyof typeof ACC;
type Posting = [Acc, number, number][]; // [account, debit, credit] in satang
interface T { net: number; vat: number; total: number; wht: number }

const sales = (t: T): Posting => [['AR', t.total, 0], ['REV', 0, t.net], ['OUT', 0, t.vat]];
const purchase = (t: T): Posting => [['EXP', t.net, 0], ['IN', t.vat, 0], ['AP', 0, t.total]];
const mirror = (p: Posting): Posting => p.map(([a, d, c]) => [a, c, d]);
const POST: Partial<Record<DocType, (t: T) => Posting>> = {
  TI: sales, IV: sales, DN: sales, CN: (t) => mirror(sales(t)),
  PB: purchase, PDN: purchase, PCN: (t) => mirror(purchase(t)),
  RC: (t) => [['BANK', t.total - t.wht, 0], ['WHT', t.wht, 0], ['AR', 0, t.total]], // bank received + WHT = total cleared from 1130
  PV: (t) => [['AP', t.total, 0], ['BANK', 0, t.total]],
};

/** Exact mirror of an entry: debit and credit swapped on every line. */
export const reversalOf = (e: JournalEntryPreview, date: string): JournalEntryPreview => ({
  date, kind: 'reversal',
  lines: e.lines.map((l) => ({ ...l, debit: l.credit, credit: l.debit, rule: `${l.rule} (กลับรายการ)` })),
});

/** Posting for the document as it stands: its original entry, plus the reversal when it is cancelled or replaced.
 *  Types without a ledger effect (N-class, JV, ...) return no entries. */
export function ledgerFor(st: MockState, doc: Doc): JournalPreview {
  const post = POST[doc.type];
  if (!post) return { entries: [] };
  const partyName = doc.party?.name ?? st.parties.find((p) => p.id === doc.header.partyId)?.name;
  const t: T = { net: toSatang(doc.totals.net), vat: toSatang(doc.totals.vat), total: toSatang(doc.totals.total), wht: toSatang(doc.totals.wht ?? '0.00') };
  // a negative side (e.g. a CN line with a negative VAT) is posted on the opposite side, never as a negative amount
  const lines = post(t).map(([a, d, c]) => [a, Math.max(d - c, 0), Math.max(c - d, 0)] as const).filter(([, d, c]) => d !== 0 || c !== 0).map(([a, d, c]) => ({
    accountCode: ACC[a][0], accountName: ACC[a][1], debit: fromSatang(d), credit: fromSatang(c), rule: RULE,
    ...(a === 'AR' || a === 'AP' ? (partyName ? { partyName } : {}) : {}),
  }));
  if (!lines.length) return { entries: [] };
  const original: JournalEntryPreview = { date: doc.header.documentDate, kind: 'original', lines };
  const entries = [original];
  if (doc.status === 'cancelled' || doc.status === 'replaced') entries.push(reversalOf(original, doc.cancel?.at.slice(0, 10) ?? doc.header.documentDate));
  return { entries };
}
