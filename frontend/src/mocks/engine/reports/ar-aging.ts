import { docViewHref } from '@/descriptors';
import type { ReportColumn, ReportModel, ReportRow, TieOut } from '@/domain/reports';
import type { MockState } from '../../store';
import { companyEntries } from '../ledger';
import { today } from '../log';
import { fromSatang, toSatang } from '../money';
import { resolveRole } from '../posting';
import { revisionInForce, controlByItem } from './as-of';
import { badParam, needDate } from './statement-lines';

type Stored = MockState['docs'][number];
export type Side = 'AR' | 'AP';

/** What differs between the receivable and the payable side: the document types that are open items, the opening-balance sides, the deposit / prepayment document, the ledger roles. */
const CFG = {
  AR: { kind: 'ar-aging' as const, types: ['TI', 'IV'], obSide: 'AR', depSide: 'DEP', depDoc: 'RC', role: 'AR' as const, depRole: 'CustomerDeposit' as const },
  AP: { kind: 'ap-aging' as const, types: ['PB'], obSide: 'AP', depSide: 'PRE', depDoc: 'PV', role: 'AP' as const, depRole: 'VendorPrepayment' as const },
};
export const BUCKETS = ['b0', 'b1', 'b2', 'b3', 'b4'] as const;
const bucketOf = (days: number) => (days <= 0 ? 0 : days <= 30 ? 1 : days <= 60 ? 2 : days <= 90 ? 3 : 4);
export const daysBetween = (later: string, earlier: string) => Math.round((Date.parse(`${later}T00:00:00Z`) - Date.parse(`${earlier}T00:00:00Z`)) / 86_400_000);

// ---------------------------------------------------------------- the open items, READ FROM THE JOURNAL (RP2a)
// Every control-account line names the open item it raises or settles (`openItemId`), so the outstanding of an item on a date is the sum of its tagged lines dated on or before it:
// it ties to the ledger by construction, on every date, whatever was revised, cancelled or posted late since. No link is read.

export interface OpenItem { doc: Stored; partyId: string; docDate: string; dueDate: string; total: number; out: number }

interface Read { items: { doc: Stored; amount: number }[]; orphans: Map<string, number> }
/** The tagged lines of one control account, by item: an item is a document of this company of one of `types` (an OB item of `obSide`); every other line (untagged, unknown id, wrong type) is an orphan of its LINE party. Amounts in the report's sign. */
function readAccount(st: MockState, companyId: string, side: Side, asOf: string, code: string, types: string[], obSide: string): Read {
  const docs = new Map(st.docs.filter((d) => d.companyId === companyId).map((d) => [d.id, d]));
  const sg = side === 'AR' ? 1 : -1, byItem = new Map<string, number>(), orphans = new Map<string, number>();
  for (const r of controlByItem(st, companyId, code, asOf)) {
    const d = docs.get(r.openItemId);
    if (d && d.header.partyId && (types.includes(d.type) || (d.type === 'OB' && d.header.obSide === obSide))) byItem.set(d.id, (byItem.get(d.id) ?? 0) + sg * r.amount);
    else orphans.set(r.partyId, (orphans.get(r.partyId) ?? 0) + sg * r.amount);
  }
  return { items: [...byItem].filter(([, v]) => v !== 0).map(([id, amount]) => ({ doc: docs.get(id)!, amount })), orphans };
}
const readMain = (st: MockState, companyId: string, side: Side, asOf: string, code: string) => readAccount(st, companyId, side, asOf, code, CFG[side].types, CFG[side].obSide);
const readDep = (st: MockState, companyId: string, side: Side, asOf: string, code: string) => readAccount(st, companyId, side, asOf, code, [CFG[side].depDoc], CFG[side].depSide);

const codeOf = (st: MockState, companyId: string, role: 'AR' | 'AP' | 'CustomerDeposit' | 'VendorPrepayment') => resolveRole(st, role, { companyId, docType: 'JV' }).code;

/** The party and dates an item carried on `asOf`: those of the revision whose posting was in force then (an OB item: its BATCH's revision), so a customer changed by a later revise is still grouped under the one the lines were posted for.
 *  Never hidden: if the reader finds nothing, the item as stored. */
function attrsOf(st: MockState, d: Stored, asOf: string): { partyId: string; docDate: string; dueDate: string } {
  const own = { partyId: d.header.partyId!, docDate: d.header.documentDate, dueDate: d.header.dueDate ?? d.header.documentDate };
  if (d.type === 'OB') {
    const it = d.header.obBatchId ? revisionInForce(st, d.header.obBatchId, asOf)?.opening?.openItems.find((i) => i.id === d.id) : undefined;
    return it ? { partyId: it.partyId, docDate: it.docDate, dueDate: it.dueDate ?? it.docDate } : own;
  }
  const r = revisionInForce(st, d.id, asOf);
  return r ? { partyId: r.header.partyId ?? own.partyId, docDate: r.header.documentDate, dueDate: r.header.dueDate ?? r.header.documentDate } : own;
}

/** The open items of one side as of a date: Σ of the journal lines tagged with the item, dated on or before the date (SP0 7.11 as of then); dates and number from the revision in force then. */
const itemsOf = (st: MockState, r: Read, asOf: string): OpenItem[] => r.items.map(({ doc, amount }): OpenItem => {
  const a = attrsOf(st, doc, asOf);
  return { doc, partyId: a.partyId, docDate: a.docDate, dueDate: a.dueDate, total: toSatang(doc.totals.total), out: amount };
});
export const openItems = (st: MockState, companyId: string, side: Side, asOf: string): OpenItem[] => itemsOf(st, readMain(st, companyId, side, asOf, codeOf(st, companyId, CFG[side].role)), asOf);

export interface DepositItem { doc: Stored; partyId: string; amount: number }
/** Customer deposits (RC) / vendor prepayments (PV) with something left on the date, plus opening-balance deposits / prepayments: Σ of the lines tagged with them on the deposit account (kept = positive). */
const depsOf = (st: MockState, r: Read, asOf: string): DepositItem[] => r.items.map(({ doc, amount }) => ({ doc, partyId: attrsOf(st, doc, asOf).partyId, amount: -amount }));
export const depositItems = (st: MockState, companyId: string, side: Side, asOf: string): DepositItem[] => depsOf(st, readDep(st, companyId, side, asOf, codeOf(st, companyId, CFG[side].depRole)), asOf);

/** The ledger balance (debit - credit, satang) of one account as of a date, per party id; '' = lines carrying no party. */
export function balancesByParty(st: MockState, companyId: string, code: string, asOf: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const e of companyEntries(st, companyId)) if (e.date <= asOf) for (const l of e.lines) if (l.accountCode === code) m.set(l.partyId ?? '', (m.get(l.partyId ?? '') ?? 0) + toSatang(l.debit) - toSatang(l.credit));
  return m;
}

// ---------------------------------------------------------------- the report

const money = (k: string, labelKey: string): ReportColumn => ({ key: k, labelKey, kind: 'money', align: 'end' });
const blank = Object.fromEntries([...BUCKETS, 'credit', 'total', 'deposit', 'gl', 'diff', 'depDiff'].map((k) => [k, '']));

/** ReportModel `ar-aging` / `ap-aging`: per party (by id, named as the master is now) the open items in the buckets by days past the basis date (due date or document date: exactly 30 days is "1-30", due today is not yet due), a separate negative
 *  deposit / prepayment column (never netted), and the ledger: Σ buckets = 1130 / 2110 of that party at the date, the deposit column = 2140 / 1140, with a party-less balance of either account as its own tie-out line. A live view of the books. */
export function agingReport(side: Side, st: MockState, companyId: string, p: Record<string, string>): ReportModel {
  const cfg = CFG[side], asOf = p.asOf ? needDate('asOf', p.asOf) : today(), basis = p.basis || 'due';
  if (basis !== 'due' && basis !== 'document') throw badParam('เกณฑ์การจัดอายุต้องเป็น due หรือ document');
  const arCode = codeOf(st, companyId, cfg.role), depCode = codeOf(st, companyId, cfg.depRole);
  const glMain = balancesByParty(st, companyId, arCode, asOf), glDep = balancesByParty(st, companyId, depCode, asOf);
  const rMain = readMain(st, companyId, side, asOf, arCode), rDep = readDep(st, companyId, side, asOf, depCode);
  const items = itemsOf(st, rMain, asOf), deps = depsOf(st, rDep, asOf);
  const name = (id: string) => st.parties.find((x) => x.companyId === companyId && x.id === id);
  const ids = [...new Set([...items.map((i) => i.partyId), ...deps.map((d) => d.partyId), ...[...glMain.keys(), ...glDep.keys()].filter(Boolean)])]
    .sort((a, b) => (name(a)?.name ?? a).localeCompare(name(b)?.name ?? b) || a.localeCompare(b));
  // the ledger in the report's own sign (Dr - Cr for a receivable and for the 2140 deposits, Cr - Dr for a payable and for the 1140 prepayments): the main account is what is owed, the deposit account what reduces it (negative)
  const led = (v: number | undefined) => (side === 'AR' ? 1 : -1) * (v ?? 0);
  const tot = { b: [0, 0, 0, 0, 0], credit: 0, total: 0, dep: 0 };
  const rows: ReportRow[] = [];
  for (const id of ids) {
    const mine = items.filter((i) => i.partyId === id).sort((a, b) => (basis === 'due' ? a.dueDate : a.docDate).localeCompare(basis === 'due' ? b.dueDate : b.docDate) || (a.doc.number ?? a.doc.id).localeCompare(b.doc.number ?? b.doc.id));
    const myDeps = deps.filter((d) => d.partyId === id);
    const b = [0, 0, 0, 0, 0];
    let credit = 0; // an item below zero (a credit note beyond the invoice): its own column, never in a bucket
    const kids: ReportRow[] = mine.map((i): ReportRow => {
      const days = daysBetween(asOf, basis === 'due' ? i.dueDate : i.docDate), k = bucketOf(days), neg = i.out < 0;
      if (neg) credit += i.out; else b[k] += i.out;
      return { level: 1, kind: 'row', href: docViewHref(i.doc.type, i.doc.id), cells: { ...blank, party: i.doc.number ?? i.doc.id, docDate: i.docDate, dueDate: i.dueDate, days: String(Math.max(days, 0)), [neg ? 'credit' : BUCKETS[k]]: fromSatang(i.out), total: fromSatang(i.out) } };
    });
    const dep = -myDeps.reduce((n, d) => n + d.amount, 0);
    for (const d of myDeps) kids.push({ level: 1, kind: 'row', href: docViewHref(d.doc.type, d.doc.id), cells: { ...blank, party: d.doc.number ?? d.doc.id, docDate: attrsOf(st, d.doc, asOf).docDate, deposit: fromSatang(-d.amount) } });
    const total = b.reduce((n, x) => n + x, 0) + credit, gl = led(glMain.get(id)), depLedger = led(glDep.get(id));
    const p0 = name(id);
    rows.push({ level: 0, kind: 'group', href: `/reports/receivables-payables?tab=${side === 'AR' ? 'cs' : 'vl'}&party=${encodeURIComponent(id)}&to=${asOf}`,
      cells: { party: p0 ? `${p0.code} ${p0.name}` : id, docDate: '', dueDate: '', days: '', ...Object.fromEntries(BUCKETS.map((k, i) => [k, fromSatang(b[i])])), credit: fromSatang(credit), total: fromSatang(total), deposit: fromSatang(dep), gl: fromSatang(gl), diff: fromSatang(total - gl), depDiff: fromSatang(dep - depLedger) } });
    rows.push(...kids);
    b.forEach((x, i) => { tot.b[i] += x; });
    tot.credit += credit; tot.total += total; tot.dep += dep;
  }
  const partyGl = [...glMain.entries()].filter(([k]) => k).reduce((n, [, v]) => n + led(v), 0), noPartyGl = led(glMain.get(''));
  const partyDep = [...glDep.entries()].filter(([k]) => k).reduce((n, [, v]) => n + led(v), 0), noPartyDep = led(glDep.get(''));
  if (rows.length) rows.push({ level: 0, kind: 'total', cells: { ...blank, party: '', docDate: '', dueDate: '', days: '', ...Object.fromEntries(BUCKETS.map((k, i) => [k, fromSatang(tot.b[i])])), credit: fromSatang(tot.credit), total: fromSatang(tot.total), deposit: fromSatang(tot.dep), gl: fromSatang(partyGl), diff: fromSatang(tot.total - partyGl), depDiff: fromSatang(tot.dep - partyDep) } });
  const pre = `reports.arap.${side === 'AR' ? 'ar' : 'ap'}`;
  const tie = (labelKey: string, left: number, right: number): TieOut => ({ labelKey, left: fromSatang(left), right: fromSatang(right), diff: fromSatang(left - right) });
  const orphan = (r: Read) => [...r.orphans].filter(([k]) => k).reduce((n, [, v]) => n + v, 0); // lines on the account naming no item of the side (party-less ones are the NoParty line)
  const tieOuts = [tie(`${pre}Tie`, tot.total, partyGl), tie(`${pre}TieNoParty`, noPartyGl, 0), tie(`${pre}TieNoItem`, orphan(rMain), 0), tie(`${pre}TieDep`, tot.dep, partyDep), tie(`${pre}TieDepNoParty`, noPartyDep, 0), tie(`${pre}TieDepNoItem`, orphan(rDep), 0)];
  const cols: ReportColumn[] = [
    { key: 'party', labelKey: side === 'AR' ? 'reports.arap.customerDoc' : 'reports.arap.vendorDoc', kind: 'text' }, { key: 'docDate', labelKey: 'reports.arap.docDate', kind: 'date' }, { key: 'dueDate', labelKey: 'reports.arap.dueDate', kind: 'date' },
    { key: 'days', labelKey: 'reports.arap.days', kind: 'qty', align: 'end' }, ...BUCKETS.map((k) => money(k, `reports.arap.${k}`)), money('credit', 'reports.arap.credit'), money('total', 'reports.arap.total'), money('deposit', side === 'AR' ? 'reports.arap.deposit' : 'reports.arap.prepayment'),
    money('gl', side === 'AR' ? 'reports.arap.glAr' : 'reports.arap.glAp'), money('diff', 'reports.arap.diff'), money('depDiff', 'reports.arap.depDiff'),
  ];
  return { kind: cfg.kind, titleKey: `reports.arap.${side === 'AR' ? 'arTitle' : 'apTitle'}`, asOf, params: { asOf, basis }, columns: cols, rows, tieOuts };
}

export const arAging = (st: MockState, companyId: string, p: Record<string, string>): ReportModel => agingReport('AR', st, companyId, p);
