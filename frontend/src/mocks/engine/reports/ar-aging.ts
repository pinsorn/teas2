import { docViewHref } from '@/descriptors';
import { CREDIT_NOTES, LIVE } from '@/domain/doc-types';
import type { ReportColumn, ReportModel, ReportRow, TieOut } from '@/domain/reports';
import type { JournalEntryPreview } from '@/domain/types';
import type { MockState } from '../../store';
import { companyEntries } from '../ledger';
import { today } from '../log';
import { fromSatang, toSatang } from '../money';
import { resolveRole } from '../posting';
import { badParam, needDate } from './statement-lines';

type Stored = MockState['docs'][number];
export type Side = 'AR' | 'AP';

/** What differs between the receivable and the payable side: the document types that are open items, the opening-balance sides, the deposit / prepayment document and its settlement kind, the ledger roles. */
const CFG = {
  AR: { kind: 'ar-aging' as const, types: ['TI', 'IV'], obSide: 'AR', depSide: 'DEP', depDoc: 'RC', settle: 'apply_deposit', role: 'AR' as const, depRole: 'CustomerDeposit' as const },
  AP: { kind: 'ap-aging' as const, types: ['PB'], obSide: 'AP', depSide: 'PRE', depDoc: 'PV', settle: 'apply_prepayment', role: 'AP' as const, depRole: 'VendorPrepayment' as const },
};
export const BUCKETS = ['b0', 'b1', 'b2', 'b3', 'b4'] as const;
const bucketOf = (days: number) => (days <= 0 ? 0 : days <= 30 ? 1 : days <= 60 ? 2 : days <= 90 ? 3 : 4);
export const daysBetween = (later: string, earlier: string) => Math.round((Date.parse(`${later}T00:00:00Z`) - Date.parse(`${earlier}T00:00:00Z`)) / 86_400_000);

// ---------------------------------------------------------------- history: what was in force on a date

interface Span { from?: string; to?: string }
/** A document / record is in force on a date from the date of its first entry until the date of the entry that reverses it (the LAST entry of a cancelled / reversed one). A later cancel or reversal never reaches back. */
const spanOf = (entries: JournalEntryPreview[], dead: boolean): Span => ({ from: entries[0]?.date, ...(dead && entries.length > 1 ? { to: entries.at(-1)!.date } : {}) });
const inForce = (s: Span, asOf: string) => !!s.from && s.from <= asOf && !(s.to && s.to <= asOf);
const docSpan = (st: MockState, d: Stored): Span => spanOf(st.journals.find((j) => j.docId === d.id)?.preview.entries ?? [], !LIVE.includes(d.status));
const recSpan = (r: MockState['settlements'][number]): Span => spanOf(r.journal, r.status === 'reversed');

export interface OpenItem { doc: Stored; partyId: string; docDate: string; dueDate: string; total: number; out: number }

/** The open items of one side as of a date. Outstanding = the document's STORED total, plus the debit notes and less the credit notes and settlements that were in force on the date (SP0 7.11 as of then): a link counts by the date of the
 *  document / record that made it, so a receipt dated after the date, or cancelled / unmatched since, is read as it stood. An opening-balance item exists from its batch's cut-off. */
export function openItems(st: MockState, companyId: string, side: Side, asOf: string): OpenItem[] {
  const cfg = CFG[side];
  const links = st.links.filter((l) => l.companyId === companyId && (l.kind === 'settles' || l.kind === 'adjusts'));
  const recs = new Map(st.settlements.filter((r) => r.companyId === companyId).map((r) => [r.id, r]));
  const docs = new Map(st.docs.filter((d) => d.companyId === companyId).map((d) => [d.id, d]));
  /** the settler's amount on this item as it stood on `asOf` (0 = not in force); an inactive link counts only when its settler is dead now (the last one it had) */
  const part = (itemId: string, from: string, kind: string): { amount: number; adj?: Stored } => {
    const ls = links.filter((l) => l.to === itemId && l.from === from && l.kind === kind);
    const rec = recs.get(from), doc = docs.get(from);
    const dead = rec ? rec.status === 'reversed' : !!doc && !LIVE.includes(doc.status);
    const use = ls.filter((l) => l.active);
    const link = use.length ? use : dead && ls.length ? [ls.at(-1)!] : [];
    const span = rec ? recSpan(rec) : doc ? docSpan(st, doc) : {};
    return { amount: inForce(span, asOf) ? link.reduce((n, l) => n + toSatang(l.amount ?? '0.00'), 0) : 0, ...(doc ? { adj: doc } : {}) };
  };
  const out: OpenItem[] = [];
  for (const d of st.docs) {
    if (d.companyId !== companyId || !d.header.partyId) continue;
    if (!(cfg.types.includes(d.type) || (d.type === 'OB' && d.header.obSide === cfg.obSide))) continue;
    const batch = d.header.obBatchId ? docs.get(d.header.obBatchId) : undefined;
    if (d.type === 'OB' && (!batch || (LIVE.includes(batch.status) && !LIVE.includes(d.status)))) continue; // an item dropped by a revise of its batch
    if (!inForce(docSpan(st, batch ?? d), asOf)) continue;
    let o = toSatang(d.totals.total);
    for (const from of new Set(links.filter((l) => l.to === d.id).map((l) => l.from))) {
      for (const kind of ['settles', 'adjusts'] as const) {
        const { amount, adj } = part(d.id, from, kind);
        if (!amount) continue;
        o += kind === 'settles' ? -amount : adj && CREDIT_NOTES.includes(adj.type) ? -amount : amount;
      }
    }
    if (o !== 0) out.push({ doc: d, partyId: d.header.partyId, docDate: d.header.documentDate, dueDate: d.header.dueDate ?? d.header.documentDate, total: toSatang(d.totals.total), out: o });
  }
  return out;
}

export interface DepositItem { doc: Stored; partyId: string; amount: number }
/** Customer deposits (RC) / vendor prepayments (PV) with something left on the date: the amount kept less the settlement records that took from it by then, plus opening-balance deposits / prepayments. */
export function depositItems(st: MockState, companyId: string, side: Side, asOf: string): DepositItem[] {
  const cfg = CFG[side];
  const recs = st.settlements.filter((r) => r.companyId === companyId && r.kind === cfg.settle && inForce(recSpan(r), asOf));
  const out: DepositItem[] = [];
  for (const d of st.docs) {
    if (d.companyId !== companyId || !d.header.partyId) continue;
    let amount = 0;
    if (d.type === cfg.depDoc) {
      if (!inForce(docSpan(st, d), asOf)) continue;
      amount = toSatang(d.header.depositAmount ?? '0.00') - recs.reduce((n, r) => n + r.sources.filter((l) => l.docId === d.id).reduce((m, l) => m + toSatang(l.amount), 0), 0);
    } else if (d.type === 'OB' && d.header.obSide === cfg.depSide) {
      const batch = st.docs.find((x) => x.id === d.header.obBatchId);
      if (!batch || (LIVE.includes(batch.status) && !LIVE.includes(d.status)) || !inForce(docSpan(st, batch), asOf)) continue;
      amount = toSatang(d.totals.total);
    }
    if (amount !== 0) out.push({ doc: d, partyId: d.header.partyId, amount });
  }
  return out;
}

/** The ledger balance (debit - credit, satang) of one account as of a date, per party id; '' = lines carrying no party. */
export function balancesByParty(st: MockState, companyId: string, code: string, asOf: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const e of companyEntries(st, companyId)) if (e.date <= asOf) for (const l of e.lines) if (l.accountCode === code) m.set(l.partyId ?? '', (m.get(l.partyId ?? '') ?? 0) + toSatang(l.debit) - toSatang(l.credit));
  return m;
}

// ---------------------------------------------------------------- the report

const money = (k: string, labelKey: string): ReportColumn => ({ key: k, labelKey, kind: 'money', align: 'end' });
const blank = Object.fromEntries([...BUCKETS, 'total', 'deposit', 'gl', 'diff', 'depDiff'].map((k) => [k, '']));

/** ReportModel `ar-aging` / `ap-aging`: per party (by id, named as the master is now) the open items in the buckets by days past the basis date (due date or document date: exactly 30 days is "1-30", due today is not yet due), a separate negative
 *  deposit / prepayment column (never netted), and the ledger: Σ buckets = 1130 / 2110 of that party at the date, the deposit column = 2140 / 1140, with a party-less balance of either account as its own tie-out line. A live view of the books. */
export function agingReport(side: Side, st: MockState, companyId: string, p: Record<string, string>): ReportModel {
  const cfg = CFG[side], asOf = p.asOf ? needDate('asOf', p.asOf) : today(), basis = p.basis || 'due';
  if (basis !== 'due' && basis !== 'document') throw badParam('เกณฑ์การจัดอายุต้องเป็น due หรือ document');
  const acct = (role: typeof cfg.role | typeof cfg.depRole) => resolveRole(st, role, { companyId, docType: 'JV' }).code;
  const arCode = acct(cfg.role), depCode = acct(cfg.depRole);
  const glMain = balancesByParty(st, companyId, arCode, asOf), glDep = balancesByParty(st, companyId, depCode, asOf);
  const items = openItems(st, companyId, side, asOf), deps = depositItems(st, companyId, side, asOf);
  const name = (id: string) => st.parties.find((x) => x.companyId === companyId && x.id === id);
  const ids = [...new Set([...items.map((i) => i.partyId), ...deps.map((d) => d.partyId), ...[...glMain.keys(), ...glDep.keys()].filter(Boolean)])]
    .sort((a, b) => (name(a)?.name ?? a).localeCompare(name(b)?.name ?? b) || a.localeCompare(b));
  // the ledger in the report's own sign (Dr - Cr for a receivable and for the 2140 deposits, Cr - Dr for a payable and for the 1140 prepayments): the main account is what is owed, the deposit account what reduces it (negative)
  const led = (v: number | undefined) => (side === 'AR' ? 1 : -1) * (v ?? 0);
  const tot = { b: [0, 0, 0, 0, 0], total: 0, dep: 0 };
  const rows: ReportRow[] = [];
  for (const id of ids) {
    const mine = items.filter((i) => i.partyId === id).sort((a, b) => (basis === 'due' ? a.dueDate : a.docDate).localeCompare(basis === 'due' ? b.dueDate : b.docDate) || (a.doc.number ?? a.doc.id).localeCompare(b.doc.number ?? b.doc.id));
    const myDeps = deps.filter((d) => d.partyId === id);
    const b = [0, 0, 0, 0, 0];
    const kids: ReportRow[] = mine.map((i): ReportRow => {
      const days = daysBetween(asOf, basis === 'due' ? i.dueDate : i.docDate), k = bucketOf(days);
      b[k] += i.out;
      return { level: 1, kind: 'row', href: docViewHref(i.doc.type, i.doc.id), cells: { ...blank, party: i.doc.number ?? i.doc.id, docDate: i.docDate, dueDate: i.dueDate, days: String(Math.max(days, 0)), [BUCKETS[k]]: fromSatang(i.out), total: fromSatang(i.out) } };
    });
    const dep = -myDeps.reduce((n, d) => n + d.amount, 0);
    for (const d of myDeps) kids.push({ level: 1, kind: 'row', href: docViewHref(d.doc.type, d.doc.id), cells: { ...blank, party: d.doc.number ?? d.doc.id, docDate: d.doc.header.documentDate, deposit: fromSatang(-d.amount) } });
    const total = b.reduce((n, x) => n + x, 0), gl = led(glMain.get(id)), depLedger = led(glDep.get(id));
    const p0 = name(id);
    rows.push({ level: 0, kind: 'group', href: `/reports/receivables-payables?tab=${side === 'AR' ? 'cs' : 'vl'}&party=${encodeURIComponent(id)}&to=${asOf}`,
      cells: { party: p0 ? `${p0.code} ${p0.name}` : id, docDate: '', dueDate: '', days: '', ...Object.fromEntries(BUCKETS.map((k, i) => [k, fromSatang(b[i])])), total: fromSatang(total), deposit: fromSatang(dep), gl: fromSatang(gl), diff: fromSatang(total - gl), depDiff: fromSatang(dep - depLedger) } });
    rows.push(...kids);
    b.forEach((x, i) => { tot.b[i] += x; });
    tot.total += total; tot.dep += dep;
  }
  const partyGl = [...glMain.entries()].filter(([k]) => k).reduce((n, [, v]) => n + led(v), 0), noPartyGl = led(glMain.get(''));
  const partyDep = [...glDep.entries()].filter(([k]) => k).reduce((n, [, v]) => n + led(v), 0), noPartyDep = led(glDep.get(''));
  if (rows.length) rows.push({ level: 0, kind: 'total', cells: { ...blank, party: '', docDate: '', dueDate: '', days: '', ...Object.fromEntries(BUCKETS.map((k, i) => [k, fromSatang(tot.b[i])])), total: fromSatang(tot.total), deposit: fromSatang(tot.dep), gl: fromSatang(partyGl), diff: fromSatang(tot.total - partyGl), depDiff: fromSatang(tot.dep - partyDep) } });
  const pre = `reports.arap.${side === 'AR' ? 'ar' : 'ap'}`;
  const tie = (labelKey: string, left: number, right: number): TieOut => ({ labelKey, left: fromSatang(left), right: fromSatang(right), diff: fromSatang(left - right) });
  const tieOuts = [tie(`${pre}Tie`, tot.total, partyGl), tie(`${pre}TieNoParty`, noPartyGl, 0), tie(`${pre}TieDep`, tot.dep, partyDep), tie(`${pre}TieDepNoParty`, noPartyDep, 0)];
  const cols: ReportColumn[] = [
    { key: 'party', labelKey: side === 'AR' ? 'reports.arap.customerDoc' : 'reports.arap.vendorDoc', kind: 'text' }, { key: 'docDate', labelKey: 'reports.arap.docDate', kind: 'date' }, { key: 'dueDate', labelKey: 'reports.arap.dueDate', kind: 'date' },
    { key: 'days', labelKey: 'reports.arap.days', kind: 'qty', align: 'end' }, ...BUCKETS.map((k) => money(k, `reports.arap.${k}`)), money('total', 'reports.arap.total'), money('deposit', side === 'AR' ? 'reports.arap.deposit' : 'reports.arap.prepayment'),
    money('gl', side === 'AR' ? 'reports.arap.glAr' : 'reports.arap.glAp'), money('diff', 'reports.arap.diff'), money('depDiff', 'reports.arap.depDiff'),
  ];
  return { kind: cfg.kind, titleKey: `reports.arap.${side === 'AR' ? 'arTitle' : 'apTitle'}`, asOf, params: { asOf, basis }, columns: cols, rows, tieOuts };
}

export const arAging = (st: MockState, companyId: string, p: Record<string, string>): ReportModel => agingReport('AR', st, companyId, p);
