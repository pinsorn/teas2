import type { ReportModel, ReportRow } from '@/domain/reports';
import type { MockState } from '../../store';
import { liveDps, liveFas, unregisteredCapex } from '../assets';
import { companyEntries } from '../ledger';
import { today } from '../log';
import { fromSatang, toSatang } from '../money';
import { lastDayOf } from '../schedules';
import { docViewHref } from '@/descriptors';

const sat = (m: string | undefined) => toSatang(m ?? '0.00');

/** The asset register (AC5): one row per live asset with its frozen cost, what it has accumulated (opening + live runs + the disposal partial) and its net book value, a subtotal per class, and a tie-out of the accumulated depreciation to the ledger.
 *  As of `asOf` (default today): an asset exists from the date of its source document; it has accumulated its opening + the live runs whose month had ended + the disposal partial once the disposal date is reached (a disposal after the date has not happened: the asset is still held).
 *  Tie-out: the held assets' accumulated + the opening-balance asset rows nobody has registered yet = GL of the accumulated-depreciation accounts up to the date. Capex lines not yet registered are listed in the notes. The class is named by the chart account it lives on. */
export function assetRegister(st: MockState, companyId: string, p: Record<string, string> = {}): ReportModel {
  const asOf = p.asOf || today();
  const dateOf = (docId: string) => st.docs.find((d) => d.id === docId)?.header.documentDate ?? '';
  const ran = liveDps(st, companyId).filter((d) => lastDayOf(d.dp!.month) <= asOf);
  const at = (f: ReturnType<typeof liveFas>[number]) => { // accumulated and what became of the asset by asOf
    const x = f.asset!, gone = !!x.disposed && x.disposed.date <= asOf;
    const acc = sat(x.opening) + ran.flatMap((d) => d.dp!.rows).filter((r) => r.assetId === f.id).reduce((n, r) => n + sat(r.amount), 0) + (gone ? sat(x.disposed!.partial) : 0);
    return { gone, acc, nbv: sat(x.cost) - acc };
  };
  const fas = liveFas(st, companyId).filter((f) => dateOf(f.asset!.source.docId) <= asOf).sort((a, b) => (a.asset!.assetClass).localeCompare(b.asset!.assetClass) || (a.number ?? '').localeCompare(b.number ?? ''));
  const rows: ReportRow[] = [];
  const classes = [...new Set(fas.map((f) => f.asset!.assetClass))];
  let cost = 0, acc = 0, nbv = 0, heldAcc = 0;
  for (const cls of classes) {
    const label = st.accounts.find((a) => a.companyId === companyId && a.code === fas.find((x) => x.asset!.assetClass === cls)!.asset!.codes.cost)?.nameTh ?? cls;
    rows.push({ level: 0, kind: 'group', cells: { number: label } });
    let c = 0, a = 0, n = 0;
    for (const f of fas.filter((x) => x.asset!.assetClass === cls)) {
      const x = f.asset!, w = at(f);
      c += sat(x.cost); a += w.acc; n += w.nbv;
      if (!w.gone) heldAcc += w.acc;
      rows.push({ level: 1, kind: 'row', href: docViewHref('FA', f.id), cells: { number: f.number ?? f.id, name: x.name, start: x.startDate, cost: x.cost, accumulated: fromSatang(w.acc), nbv: fromSatang(w.nbv), status: w.gone ? (x.disposed!.kind === 'sale' ? 'ขาย' : 'ตัดจำหน่าย') : 'ใช้งานอยู่' } });
    }
    rows.push({ level: 0, kind: 'subtotal', cells: { name: label, cost: fromSatang(c), accumulated: fromSatang(a), nbv: fromSatang(n) } });
    cost += c; acc += a; nbv += n;
  }
  rows.push({ level: 0, kind: 'total', cells: { cost: fromSatang(cost), accumulated: fromSatang(acc), nbv: fromSatang(nbv) } });

  const accCodes = new Set(st.accounts.filter((a) => a.companyId === companyId && a.subClass === 'accumulated-depreciation').map((a) => a.code));
  let gl = 0;
  for (const e of companyEntries(st, companyId)) if (e.date <= asOf) for (const l of e.lines) if (accCodes.has(l.accountCode)) gl += sat(l.credit) - sat(l.debit);
  const waiting = unregisteredCapex(st, companyId);
  const unregistered = waiting.filter((u) => u.docType === 'OB' && dateOf(u.source.docId) <= asOf).reduce((n, u) => n + sat(u.accumulated), 0);
  const books = heldAcc + unregistered;
  return {
    kind: 'asset-register', titleKey: 'reports.assetRegister.title', asOf, params: { asOf },
    columns: [
      { key: 'number', labelKey: 'reports.assetRegister.number', kind: 'text' }, { key: 'name', labelKey: 'reports.assetRegister.name', kind: 'text' }, { key: 'start', labelKey: 'reports.assetRegister.start', kind: 'date' },
      { key: 'cost', labelKey: 'reports.assetRegister.cost', kind: 'money', align: 'end' }, { key: 'accumulated', labelKey: 'reports.assetRegister.accumulated', kind: 'money', align: 'end' },
      { key: 'nbv', labelKey: 'reports.assetRegister.nbv', kind: 'money', align: 'end' }, { key: 'status', labelKey: 'reports.assetRegister.status', kind: 'text' },
    ],
    rows,
    tieOuts: [{ labelKey: 'reports.assetRegister.tie', left: fromSatang(books), right: fromSatang(gl), diff: fromSatang(books - gl) }],
    ...(waiting.length ? { notes: [`ยังไม่ได้ลงทะเบียน ${waiting.length} รายการ`] } : {}),
  };
}
