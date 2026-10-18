import { docViewHref } from '@/descriptors';
import { CREDIT_NOTES, LIVE } from '@/domain/doc-types';
import type { ReportColumn, ReportModel, ReportRow, TieOut } from '@/domain/reports';
import type { DocType } from '@/domain/types';
import type { MockState } from '../../store';
import { pp30RowOf } from '../filings/pp30';
import { today } from '../log';
import { fromSatang, toSatang } from '../money';
import { isRecoverable } from '../purchase-vat';
import { computeDoc, vatOf } from '../vat';
import { badParam, needDate } from './statement-lines';
import { vatInputRegister } from './vat-input-register';
import { vatOutputRegister } from './vat-output-register';

type Stored = MockState['docs'][number];
export type SummaryKind = 'sales' | 'purchases';
const CFG = {
  sales: { kind: 'sales-summary' as const, types: ['TI', 'IV', 'DN', 'CN'] as DocType[], title: 'reports.sales.title' },
  purchases: { kind: 'purchase-summary' as const, types: ['PB', 'PDN', 'PCN'] as DocType[], title: 'reports.purchases.title' },
};
const NONE_TH = 'ไม่ระบุ', NO_ITEM_TH = 'ไม่ระบุสินค้า/บริการ';
const monthsOf = (from: string, to: string) => { const out: string[] = []; for (let m = from.slice(0, 7); m <= to.slice(0, 7); m = Number(m.slice(5)) === 12 ? `${Number(m.slice(0, 4)) + 1}-01` : `${m.slice(0, 5)}${String(Number(m.slice(5)) + 1).padStart(2, '0')}`) out.push(m); return out; };

interface Part { key: string; label: string; href?: string; net: number; vat: number; total: number; claim: number; docs: Set<string> }

/** ReportModel `sales-summary` / `purchase-summary`: the live documents of the range by DOCUMENT date (TI / IV / DN positive, CN negative; purchases PB / PDN positive, PCN negative), grouped by customer (vendor) id, item, a dimension type or month.
 *  Net, VAT (a VAT company only) and total come from the documents' STORED totals; the split over groups is by line and any rounding left over goes to the document's first line, so Σ groups = the grand total always.
 *  Tied to the VAT register of the same range: the output register for sales, the input register for purchases, whose own rules (claim period, recoverable VAT only) are called, not repeated. A live view of the books. */
export function summaryReport(which: SummaryKind, st: MockState, companyId: string, p: Record<string, string>): ReportModel {
  const cfg = CFG[which], vat = vatOf(st, companyId), showVat = vat || which === 'purchases'; // a vendor's VAT is on the bill whatever our own status; only our own sales VAT needs the registration
  const to = p.to ? needDate('to', p.to) : today(), from = p.from ? needDate('from', p.from) : `${to.slice(0, 4)}-01-01`;
  if (from > to) throw badParam('วันที่เริ่มต้นต้องไม่หลังวันที่สิ้นสุด');
  let by = (p.groupBy || 'customer').trim(), dimType = (p.dimension ?? '').trim();
  if (by.startsWith('dimension:')) { dimType = by.slice('dimension:'.length).trim(); by = 'dimension'; }
  if (by === 'vendor') by = 'customer';
  if (!['customer', 'item', 'dimension', 'month'].includes(by)) throw badParam('groupBy ต้องเป็น customer, item, dimension หรือ month');
  if (by === 'dimension' && !dimType) throw badParam('ต้องระบุประเภทมิติ (dimension) ที่ต้องการแยก');
  const docs = st.docs.filter((d) => d.companyId === companyId && cfg.types.includes(d.type) && LIVE.includes(d.status) && d.header.documentDate >= from && d.header.documentDate <= to);
  const parts = new Map<string, Part>();
  const master = (id: string | undefined) => st.parties.find((x) => x.companyId === companyId && x.id === id);
  const keyOf = (d: Stored, l?: Stored['lines'][number]): { key: string; label: string; href?: string } => {
    if (by === 'month') return { key: d.header.documentDate.slice(0, 7), label: d.header.documentDate.slice(0, 7) };
    if (by === 'customer') { const x = master(d.header.partyId); return { key: d.header.partyId ?? '', label: x ? `${x.code} ${x.name}` : d.party?.name ?? NONE_TH, href: d.header.partyId ? `/reports/receivables-payables?tab=${which === 'sales' ? 'cs' : 'vl'}&party=${encodeURIComponent(d.header.partyId)}&from=${from}&to=${to}` : undefined }; }
    if (by === 'item') { const x = st.items.find((i) => i.companyId === companyId && i.id === l?.itemId); return { key: l?.itemId ?? '', label: x ? `${x.code} ${x.name}` : NO_ITEM_TH }; }
    const v = l?.dimensions?.[dimType] ?? d.header.dimensions?.[dimType]; // a line's value wins over the header's, as the ledger posts it
    return { key: v ?? '', label: v ?? NONE_TH };
  };
  const add = (k: ReturnType<typeof keyOf>, d: Stored, net: number, v: number, total: number, claim: number) => {
    const g = parts.get(k.key) ?? { ...k, net: 0, vat: 0, total: 0, claim: 0, docs: new Set<string>() };
    g.net += net; g.vat += v; g.total += total; g.claim += claim; g.docs.add(d.id); parts.set(k.key, g);
  };
  let gNet = 0, gVat = 0, gTotal = 0, gClaim = 0;
  for (const d of docs) {
    const sign = CREDIT_NOTES.includes(d.type) ? -1 : 1;
    const rs = computeDoc(d.lines, !!d.header.priceIncludesVat, which === 'sales' ? vat : true).lines;
    const tn = toSatang(d.totals.net), tv = toSatang(d.totals.vat), tt = toSatang(d.totals.total);
    const claim = which === 'purchases' && vat ? toSatang(pp30RowOf(st, d)?.vat ?? '0.00') : 0; // already signed (a credit note gives it back)
    gNet += sign * tn; gVat += sign * tv; gTotal += sign * tt; gClaim += claim;
    // a line's claimed VAT is its VAT when the register would claim it (the register's own test, per line); what the register says for the whole document and the lines do not give goes to the first line
    const line = d.lines.length ? d.lines.map((l, i) => ({ l, n: toSatang(rs[i].net), v: toSatang(rs[i].vat), t: toSatang(rs[i].total), c: claim && isRecoverable(st, companyId, l, d.header.inputVatForfeited) ? sign * toSatang(rs[i].vat) : 0 })) : [{ l: undefined, n: 0, v: 0, t: 0, c: 0 }];
    const rn = tn - line.reduce((n, x) => n + x.n, 0), rv = tv - line.reduce((n, x) => n + x.v, 0), rt = tt - line.reduce((n, x) => n + x.t, 0), rc = claim - line.reduce((n, x) => n + x.c, 0); // the stored total stands: rounding goes to the first line
    // the claimed VAT follows the document's own lines for item / dimension (the recoverable share of each line's VAT); the rest of it, if any, to the first line
    line.forEach((x, i) => add(keyOf(d, x.l), d, sign * (x.n + (i ? 0 : rn)), sign * (x.v + (i ? 0 : rv)), sign * (x.t + (i ? 0 : rt)), x.c + (i ? 0 : rc)));
  }
  const ordered = [...parts.values()].sort((a, b) => (by === 'month' ? a.key.localeCompare(b.key) : a.key === '' ? 1 : b.key === '' ? -1 : a.label.localeCompare(b.label)));
  const rows: ReportRow[] = ordered.map((g): ReportRow => ({ level: 0, kind: 'row', ...(g.href ? { href: g.href } : {}),
    cells: { group: g.label, docs: String(g.docs.size), net: fromSatang(g.net), ...(showVat ? { vat: fromSatang(g.vat) } : {}), ...(which === 'purchases' && vat ? { claim: fromSatang(g.claim) } : {}), total: fromSatang(g.total) } }));
  if (rows.length) rows.push({ level: 0, kind: 'total', cells: { group: '', docs: String(docs.length), net: fromSatang(gNet), ...(showVat ? { vat: fromSatang(gVat) } : {}), ...(which === 'purchases' && vat ? { claim: fromSatang(gClaim) } : {}), total: fromSatang(gTotal) } });
  const sumRows = (k: 'net' | 'vat' | 'total' | 'claim') => ordered.reduce((n, g) => n + g[k], 0);
  const tie = (labelKey: string, left: number, right: number): TieOut => ({ labelKey, left: fromSatang(left), right: fromSatang(right), diff: fromSatang(left - right) });
  const tieOuts: TieOut[] = [tie(`reports.${which}.tieDocs`, sumRows('total'), gTotal)];
  const notes: string[] = [];
  if (vat && which === 'sales') {
    // the output register of every month the range touches, its rows dated inside the range
    let reg = 0;
    for (const period of monthsOf(from, to)) for (const r of vatOutputRegister(st, companyId, { period }).rows) if (r.kind === 'row' && r.cells.date >= from && r.cells.date <= to) reg += toSatang(r.cells.vat);
    tieOuts.push(tie('reports.sales.tieVat', sumRows('vat'), reg));
  }
  if (vat && which === 'purchases') {
    // the input register counts a bill in its CLAIM month and only the VAT that can be claimed: ask it for the claim month of each document and read the rows of THESE documents
    const mine = new Set(docs.map((d) => docViewHref(d.type, d.id)));
    const months = new Set(docs.flatMap((d) => { const r = pp30RowOf(st, d); return r && toSatang(r.vat) !== 0 && r.claimPeriod ? [r.claimPeriod] : []; }));
    let reg = 0;
    for (const period of months) for (const r of vatInputRegister(st, companyId, { period }).rows) if (r.kind === 'row' && r.href && mine.has(r.href)) reg += toSatang(r.cells.vat);
    tieOuts.push(tie('reports.purchases.tieVat', sumRows('claim'), reg));
    notes.push('แยกตามวันที่เอกสาร ส่วนภาษีซื้อที่ขอคืนได้ตามงวดที่ขอคืน (claim period) ของทะเบียนภาษีซื้อ และเฉพาะภาษีที่ขอได้');
  }
  const money = (key: string, labelKey: string): ReportColumn => ({ key, labelKey, kind: 'money', align: 'end' });
  const groupLabel = by === 'month' ? 'reports.summary.month' : by === 'item' ? 'reports.summary.item' : by === 'dimension' ? 'reports.summary.dimension' : which === 'sales' ? 'reports.summary.customer' : 'reports.summary.vendor';
  const columns: ReportColumn[] = [{ key: 'group', labelKey: groupLabel, kind: 'text' }, { key: 'docs', labelKey: 'reports.summary.docs', kind: 'qty', align: 'end' }, money('net', 'reports.summary.net'),
    ...(showVat ? [money('vat', 'reports.summary.vat')] : []), ...(which === 'purchases' && vat ? [money('claim', 'reports.summary.claim')] : []), money('total', 'reports.summary.total')];
  return { kind: cfg.kind, titleKey: cfg.title, params: { from, to, groupBy: by, ...(by === 'dimension' ? { dimension: dimType } : {}) }, columns, rows, tieOuts, ...(notes.length ? { notes } : {}) };
}

export const salesSummary = (st: MockState, companyId: string, p: Record<string, string>): ReportModel => summaryReport('sales', st, companyId, p);
