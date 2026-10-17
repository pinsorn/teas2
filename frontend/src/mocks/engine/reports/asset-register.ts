import type { ReportModel, ReportRow } from '@/domain/reports';
import type { MockState } from '../../store';
import { liveFas, unregisteredCapex } from '../assets';
import { companyEntries } from '../ledger';
import { today } from '../log';
import { fromSatang, toSatang } from '../money';
import { docViewHref } from '@/descriptors';

const sat = (m: string | undefined) => toSatang(m ?? '0.00');

/** The asset register (AC5): one row per live asset with its frozen cost, what it has accumulated (opening + live runs + the disposal partial) and its net book value, a subtotal per class, and a tie-out of the accumulated depreciation to the ledger.
 *  Tie-out: the live, undisposed assets' accumulated + the opening-balance asset rows nobody has registered yet = GL of the accumulated-depreciation accounts. Today's state (no as-of history). Capex lines not yet registered are listed in the notes. */
export function assetRegister(st: MockState, companyId: string, _p: Record<string, string> = {}): ReportModel {
  void _p;
  const fas = liveFas(st, companyId).sort((a, b) => (a.asset!.assetClass).localeCompare(b.asset!.assetClass) || (a.number ?? '').localeCompare(b.number ?? ''));
  const rows: ReportRow[] = [];
  const classes = [...new Set(fas.map((f) => f.asset!.assetClass))];
  let cost = 0, acc = 0, nbv = 0, heldAcc = 0;
  for (const cls of classes) {
    rows.push({ level: 0, kind: 'group', cells: { number: cls } });
    let c = 0, a = 0, n = 0;
    for (const f of fas.filter((x) => x.asset!.assetClass === cls)) {
      const x = f.asset!;
      c += sat(x.cost); a += sat(x.accumulated); n += sat(x.nbv);
      if (!x.disposed) heldAcc += sat(x.accumulated);
      rows.push({ level: 1, kind: 'row', href: docViewHref('FA', f.id), cells: { number: f.number ?? f.id, name: x.name, start: x.startDate, cost: x.cost, accumulated: x.accumulated, nbv: x.nbv, status: x.disposed ? x.disposed.kind : 'held' } });
    }
    rows.push({ level: 0, kind: 'subtotal', cells: { name: cls, cost: fromSatang(c), accumulated: fromSatang(a), nbv: fromSatang(n) } });
    cost += c; acc += a; nbv += n;
  }
  rows.push({ level: 0, kind: 'total', cells: { cost: fromSatang(cost), accumulated: fromSatang(acc), nbv: fromSatang(nbv) } });

  const accCodes = new Set(st.accounts.filter((a) => a.companyId === companyId && a.subClass === 'accumulated-depreciation').map((a) => a.code));
  let gl = 0;
  for (const e of companyEntries(st, companyId)) for (const l of e.lines) if (accCodes.has(l.accountCode)) gl += sat(l.credit) - sat(l.debit);
  const waiting = unregisteredCapex(st, companyId);
  const unregistered = waiting.filter((u) => u.docType === 'OB').reduce((n, u) => n + sat(u.accumulated), 0);
  const books = heldAcc + unregistered;
  return {
    kind: 'asset-register', titleKey: 'reports.assetRegister.title', asOf: today(), params: {},
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
