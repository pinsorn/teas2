import type { ReportModel, ReportRow } from '@/domain/reports';
import type { DpRow } from '@/domain/types';
import type { MockState } from '../../store';
import { liveFas, unregisteredCapex } from '../assets';
import { companyEntries } from '../ledger';
import { today } from '../log';
import { fromSatang, toSatang } from '../money';
import { resolveRole } from '../posting';
import { docViewHref } from '@/descriptors';

const sat = (m: string | undefined) => toSatang(m ?? '0.00');

/** The asset register (AC5): one row per live asset with its frozen cost, what it has accumulated (opening + live runs + the disposal partial) and its net book value, a subtotal per class, and a tie-out of the accumulated depreciation to the ledger.
 *  As of `asOf` (default today): an asset exists from the date of its source document; it has accumulated its opening + the run rows and the disposal partial that the ledger entries dated by then stand for (so a run or sale cancelled later still counts on the earlier date, and the tie-out holds on any date).
 *  Tie-out: the held assets' accumulated + the opening-balance asset rows nobody has registered yet = GL of the accumulated-depreciation accounts up to the date. Capex lines not yet registered are listed in the notes. The class is named by the chart account it lives on. */
export function assetRegister(st: MockState, companyId: string, p: Record<string, string> = {}): ReportModel {
  const asOf = p.asOf || today();
  const dateOf = (docId: string) => st.docs.find((d) => d.id === docId)?.header.documentDate ?? '';
  // The date is history: a run / disposal counts by its ENTRIES dated by asOf (a reversal counts from its own date), not by whether it is live today. A run's rows are those of the revision its latest entry stands for.
  const runRows = st.docs.filter((d) => d.companyId === companyId && d.type === 'DP' && !!d.dp).flatMap((d) => {
    let rev = 0, rows: DpRow[] = [];
    for (const e of st.journals.find((j) => j.docId === d.id)?.preview.entries ?? []) {
      if (e.kind === 'correction') rev++;
      if (e.date <= asOf) rows = e.kind === 'reversal' ? [] : st.revisions.find((r) => r.docId === d.id && r.revision === rev)?.snapshot.dp?.rows ?? d.dp!.rows;
    }
    return rows;
  });
  const at = (f: ReturnType<typeof liveFas>[number]) => { // accumulated and what became of the asset by asOf: the disposal is the invoice (a sale) or the asset's own entry (a write-off) whose entries dated by asOf still remove its cost
    const x = f.asset!, tis = st.docs.filter((d) => d.header.disposal?.faId === f.id).map((d) => d.id);
    const net = (id: string, code: string) => (st.journals.find((j) => j.docId === id)?.preview.entries ?? []).filter((e) => e.date <= asOf).flatMap((e) => e.lines).filter((l) => l.accountCode === code).reduce((n, l) => n + sat(l.debit) - sat(l.credit), 0);
    const by = [f.id, ...tis].find((id) => net(id, x.codes.cost) < 0), partial = by ? net(by, x.codes.expense) : 0;
    const acc = sat(x.opening) + runRows.filter((r) => r.assetId === f.id).reduce((n, r) => n + sat(r.amount), 0) + partial;
    return { gone: !!by, sale: !!by && by !== f.id, acc, nbv: sat(x.cost) - acc };
  };
  const fas = liveFas(st, companyId).filter((f) => dateOf(f.asset!.source.docId) <= asOf).sort((a, b) => (a.asset!.assetClass).localeCompare(b.asset!.assetClass) || (a.number ?? '').localeCompare(b.number ?? ''));
  const rows: ReportRow[] = [];
  const held = fas.filter((f) => !at(f).gone), sold = fas.filter((f) => at(f).gone);
  const line = (f: (typeof fas)[number]): ReportRow => { const x = f.asset!, w = at(f); return { level: 1, kind: 'row', href: docViewHref('FA', f.id), cells: { number: f.number ?? f.id, name: x.name, start: x.startDate, cost: x.cost, accumulated: fromSatang(w.acc), nbv: fromSatang(w.nbv), status: w.gone ? (w.sale ? 'ขาย' : 'ตัดจำหน่าย') : 'ใช้งานอยู่' } }; };
  let cost = 0, acc = 0, nbv = 0;
  for (const cls of [...new Set(held.map((f) => f.asset!.assetClass))]) { // the totals are the assets HELD at asOf: what the ledger carries
    const mine = held.filter((x) => x.asset!.assetClass === cls);
    const label = st.accounts.find((a) => a.companyId === companyId && a.code === mine[0].asset!.codes.cost)?.nameTh ?? cls;
    rows.push({ level: 0, kind: 'group', cells: { number: label } });
    let c = 0, a = 0, n = 0;
    for (const f of mine) { const w = at(f); c += sat(f.asset!.cost); a += w.acc; n += w.nbv; rows.push(line(f)); }
    rows.push({ level: 0, kind: 'subtotal', cells: { name: label, cost: fromSatang(c), accumulated: fromSatang(a), nbv: fromSatang(n) } });
    cost += c; acc += a; nbv += n;
  }
  rows.push({ level: 0, kind: 'total', cells: { cost: fromSatang(cost), accumulated: fromSatang(acc), nbv: fromSatang(nbv) } });
  if (sold.length) { // sold / written off by asOf: listed with their status, outside every total
    rows.push({ level: 0, kind: 'group', cells: { number: 'จำหน่ายแล้ว (ไม่รวมในยอดรวม)' } });
    for (const f of sold) rows.push(line(f));
  }

  const accCodes = new Set(st.accounts.filter((a) => a.companyId === companyId && a.subClass === 'accumulated-depreciation').map((a) => a.code));
  const costCodes = new Set(st.accounts.filter((a) => a.companyId === companyId && a.subClass === 'fixed-asset').map((a) => a.code));
  let gl = 0, glCost = 0;
  const glBy = new Map<string, number>(); // the same ledger sums per account (cost: debit - credit, accumulated: credit - debit), for the tie-out of each class
  for (const e of companyEntries(st, companyId)) if (e.date <= asOf) for (const l of e.lines) {
    if (accCodes.has(l.accountCode)) { gl += sat(l.credit) - sat(l.debit); glBy.set(l.accountCode, (glBy.get(l.accountCode) ?? 0) + sat(l.credit) - sat(l.debit)); }
    if (costCodes.has(l.accountCode)) { glCost += sat(l.debit) - sat(l.credit); glBy.set(l.accountCode, (glBy.get(l.accountCode) ?? 0) + sat(l.debit) - sat(l.credit)); }
  }
  const waiting = unregisteredCapex(st, companyId);
  const unregistered = waiting.filter((u) => u.docType === 'OB' && dateOf(u.source.docId) <= asOf).reduce((n, u) => n + sat(u.accumulated), 0);
  const unregisteredCost = waiting.filter((u) => dateOf(u.source.docId) <= asOf).reduce((n, u) => n + sat(u.cost), 0); // capex the ledger carries that no asset stands on yet
  const books = acc + unregistered, booksCost = cost + unregisteredCost;
  // RP2 ruling 6: each class account on its own (1210 / 1211 equipment, 1220 / 1221 vehicles) against the ledger of that account: the held assets on it plus what nobody has registered yet
  const booksBy = new Map<string, number>();
  const bump = (code: string, v: number) => booksBy.set(code, (booksBy.get(code) ?? 0) + v);
  for (const f of held) { bump(f.asset!.codes.cost, sat(f.asset!.cost)); bump(f.asset!.codes.accumulated, at(f).acc); }
  for (const u of waiting.filter((x) => dateOf(x.source.docId) <= asOf)) {
    const ob = u.docType === 'OB' ? st.docs.find((d) => d.id === u.source.docId) : undefined, ctx = { companyId, docType: u.docType, assetClass: u.assetClass };
    // ST2b ruling 3: a bill's cost sits on the account the bill POSTED (frozen on the line), not on whatever the rule says today
    const src = u.source, billAcc = src.kind === 'bill' ? st.docs.find((x) => x.id === src.docId)?.lines.find((x) => x.id === src.lineId)?.postedAccount : undefined;
    const costAcc = src.kind === 'bill' ? billAcc : ob?.opening?.codes?.[`FixedAsset:${u.assetClass}`] ?? resolveRole(st, 'FixedAsset', ctx).code; // a bill without its stamp is invariant 26, not a guess
    if (costAcc) bump(costAcc, sat(u.cost));
    if (ob) bump(ob.opening?.codes?.[`AccumulatedDepreciation:${u.assetClass}`] ?? resolveRole(st, 'AccumulatedDepreciation', ctx).code, sat(u.accumulated));
  }
  const classTies = ['1210', '1211', '1220', '1221'].filter((c) => costCodes.has(c) || accCodes.has(c))
    .map((c) => ({ labelKey: `reports.assetRegister.tie${c}`, left: fromSatang(booksBy.get(c) ?? 0), right: fromSatang(glBy.get(c) ?? 0), diff: fromSatang((booksBy.get(c) ?? 0) - (glBy.get(c) ?? 0)) }));
  return {
    kind: 'asset-register', titleKey: 'reports.assetRegister.title', asOf, params: { asOf },
    columns: [
      { key: 'number', labelKey: 'reports.assetRegister.number', kind: 'text' }, { key: 'name', labelKey: 'reports.assetRegister.name', kind: 'text' }, { key: 'start', labelKey: 'reports.assetRegister.start', kind: 'date' },
      { key: 'cost', labelKey: 'reports.assetRegister.cost', kind: 'money', align: 'end' }, { key: 'accumulated', labelKey: 'reports.assetRegister.accumulated', kind: 'money', align: 'end' },
      { key: 'nbv', labelKey: 'reports.assetRegister.nbv', kind: 'money', align: 'end' }, { key: 'status', labelKey: 'reports.assetRegister.status', kind: 'text' },
    ],
    rows,
    tieOuts: [{ labelKey: 'reports.assetRegister.tie', left: fromSatang(books), right: fromSatang(gl), diff: fromSatang(books - gl) }, { labelKey: 'reports.assetRegister.tieCost', left: fromSatang(booksCost), right: fromSatang(glCost), diff: fromSatang(booksCost - glCost) }, ...classTies],
    ...(waiting.length ? { notes: [`ยังไม่ได้ลงทะเบียน ${waiting.length} รายการ`] } : {}),
  };
}
