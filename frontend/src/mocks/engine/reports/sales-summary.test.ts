import { beforeEach, describe, expect, it } from 'vitest';
import { CREDIT_NOTES, LIVE } from '@/domain/doc-types';
import type { ReportModel } from '@/domain/reports';
import type { DocType } from '@/domain/types';
import { buildSeedState, type MockState } from '../../store';
import { today } from '../log';
import { toSatang } from '../money';
import { purchaseSummary } from './purchase-summary';
import { salesSummary } from './sales-summary';
import { vatInputRegister } from './vat-input-register';
import { vatOutputRegister } from './vat-output-register';

const VAT = 'co-vat', NV = 'co-nonvat';
let st: MockState;
beforeEach(() => { localStorage.clear(); st = buildSeedState(); });

const body = (m: ReportModel) => m.rows.filter((r) => r.kind === 'row');
const ZERO = { net: '0.00', vat: '0.00', total: '0.00', claim: '0.00' };
const grand = (m: ReportModel) => m.rows.find((r) => r.kind === 'total')?.cells ?? ZERO; // a range with no document has no rows at all
const sum = (m: ReportModel, k: string) => body(m).reduce((n, r) => n + toSatang(r.cells[k] || '0.00'), 0);
const err = (fn: () => unknown) => { try { fn(); } catch (e) { return e as { status?: number; code?: string }; } return undefined; };
/** The test's own oracle: the stored totals of the live documents of the given types, dated in the range, credit notes negative. */
const oracle = (co: string, types: DocType[], from: string, to: string) => {
  const mine = st.docs.filter((d) => d.companyId === co && types.includes(d.type) && LIVE.includes(d.status) && d.header.documentDate >= from && d.header.documentDate <= to);
  const k = (t: DocType) => (CREDIT_NOTES.includes(t) ? -1 : 1);
  const s = (f: (d: (typeof mine)[number]) => string) => mine.reduce((n, d) => n + k(d.type) * toSatang(f(d)), 0);
  return { net: s((d) => d.totals.net), vat: s((d) => d.totals.vat), total: s((d) => d.totals.total), n: mine.length };
};
const GROUPS = [{ groupBy: 'customer' }, { groupBy: 'item' }, { groupBy: 'month' }, { groupBy: 'dimension', dimension: 'project' }] as const;
const RANGES = [['2025-01-01', '2026-12-31'], ['2026-03-01', '2026-06-30'], ['2026-10-01', '2026-10-14'], ['2026-09-15', '2026-10-03']] as const;

describe('ruling 4: sales summary', () => {
  it.each(GROUPS.flatMap((g) => [[VAT, g], [NV, g]] as const))('%s %j: Σ groups = the grand total = the stored totals of the documents (live TI / IV / DN, CN negative, by document date)', (co, g) => {
    for (const [from, to] of RANGES) {
      const m = salesSummary(st, co, { from, to, ...g });
      const o = oracle(co, co === VAT ? ['TI', 'DN', 'CN'] : ['IV', 'TI', 'DN', 'CN'], from, to);
      expect(sum(m, 'net'), `${from}..${to} net`).toBe(o.net);
      expect(sum(m, 'total'), 'total').toBe(o.total);
      if (co === VAT) expect(sum(m, 'vat'), 'vat').toBe(o.vat);
      expect(toSatang(grand(m).net)).toBe(o.net);
      expect(toSatang(grand(m).total)).toBe(o.total);
      expect(m.tieOuts!.find((t) => t.labelKey === 'reports.sales.tieDocs')).toMatchObject({ diff: '0.00' });
      expect(m.tieOuts!.every((t) => t.diff === '0.00'), JSON.stringify(m.tieOuts)).toBe(true);
    }
  });
  it('the VAT column is the output VAT register of the same range (it is called, not re-summed), for whole months and for a part of a month', () => {
    for (const [from, to, periods] of [['2026-03-01', '2026-03-31', ['2026-03']], ['2026-09-01', '2026-10-31', ['2026-09', '2026-10']], ['2026-09-15', '2026-10-03', ['2026-09', '2026-10']]] as const) {
      const m = salesSummary(st, VAT, { from, to, groupBy: 'month' });
      let reg = 0;
      for (const period of periods) for (const r of vatOutputRegister(st, VAT, { period }).rows) if (r.kind === 'row' && r.cells.date >= from && r.cells.date <= to) reg += toSatang(r.cells.vat);
      expect(toSatang(grand(m).vat), `${from}..${to}`).toBe(reg);
      expect(m.tieOuts!.find((t) => t.labelKey === 'reports.sales.tieVat')).toMatchObject({ diff: '0.00' });
    }
    const whole = vatOutputRegister(st, VAT, { period: '2026-03' }).rows.find((r) => r.kind === 'total')!.cells.vat;
    expect(grand(salesSummary(st, VAT, { from: '2026-03-01', to: '2026-03-31' })).vat).toBe(whole);
  });
  it('the stored totals stand: a document whose lines do not add up to its stored total still lands in the groups whole (the rounding goes to its first line), and the VAT tie-out sees a figure the register does not', () => {
    const ti = st.docs.find((d) => d.companyId === VAT && d.type === 'TI' && d.status === 'issued' && d.lines.length > 1 && d.header.documentDate >= '2026-09-01')!;
    ti.totals = { ...ti.totals, net: (Number(ti.totals.net) + 0.01).toFixed(2), vat: (Number(ti.totals.vat) + 0.01).toFixed(2), total: (Number(ti.totals.total) + 0.02).toFixed(2) };
    for (const g of GROUPS) {
      const m = salesSummary(st, VAT, { from: '2026-09-01', to: '2026-10-14', ...g });
      expect(sum(m, 'total'), JSON.stringify(g)).toBe(toSatang(grand(m).total));
      expect(sum(m, 'net')).toBe(toSatang(grand(m).net));
      expect(m.tieOuts!.find((t) => t.labelKey === 'reports.sales.tieDocs')!.diff).toBe('0.00');
      expect(m.tieOuts!.find((t) => t.labelKey === 'reports.sales.tieVat')!.diff).toBe('0.01'); // the register recomputes from the lines: it does not hold the extra cent
    }
  });
  it('credit notes are negative and a debit note adds', () => {
    // CN-202610-0002 (-8,966.60 / 2026-10-09) and DN-202610-0001 (+535.00 / 2026-10-10)
    const withNotes = salesSummary(st, VAT, { from: '2026-10-09', to: '2026-10-10', groupBy: 'month' });
    const o = oracle(VAT, ['TI', 'DN', 'CN'], '2026-10-09', '2026-10-10');
    expect(toSatang(grand(withNotes).total)).toBe(o.total);
    const cnOnly = oracle(VAT, ['CN'], '2026-10-09', '2026-10-09');
    expect(cnOnly.total).toBeLessThan(0);
    expect(oracle(VAT, ['DN'], '2026-10-10', '2026-10-10').total).toBeGreaterThan(0);
  });
  it('cancelled, replaced and draft documents are not in it', () => {
    const before = grand(salesSummary(st, VAT, { from: '2025-01-01', to: '2026-12-31' })).total;
    for (const d of st.docs) if (d.companyId === VAT && d.type === 'TI' && d.status === 'replaced') expect(LIVE.includes(d.status)).toBe(false);
    expect(toSatang(before)).toBe(oracle(VAT, ['TI', 'DN', 'CN'], '2025-01-01', '2026-12-31').total);
  });
  it('the range is by document date and inclusive at both ends', () => {
    const ti = st.docs.find((d) => d.number === 'TI-202609-0006')!;
    const day = ti.header.documentDate;
    const at = (from: string, to: string) => toSatang(grand(salesSummary(st, VAT, { from, to })).total);
    expect(at(day, day)).toBeGreaterThanOrEqual(toSatang(ti.totals.total));
    expect(at(day, day)).toBe(oracle(VAT, ['TI', 'DN', 'CN'], day, day).total);
  });
  it('by customer: the party is its id, named as the master is now; a rename moves nothing and same-named customers stay apart', () => {
    const before = salesSummary(st, VAT, { from: '2025-01-01', to: '2026-12-31', groupBy: 'customer' });
    const p = st.parties.find((x) => x.id === 'pc-10')!;
    p.name = 'ชื่อใหม่ จำกัด';
    st.parties.find((x) => x.id === 'pc-09')!.name = 'ชื่อใหม่ จำกัด';
    const after = salesSummary(st, VAT, { from: '2025-01-01', to: '2026-12-31', groupBy: 'customer' });
    expect(body(after)).toHaveLength(body(before).length);
    expect(body(after).filter((r) => r.cells.group.endsWith('ชื่อใหม่ จำกัด'))).toHaveLength(2);
    expect(sum(after, 'total')).toBe(sum(before, 'total'));
  });
  it('by item: an item\'s name from the master, lines without an item together', () => {
    const m = salesSummary(st, NV, { from: '2025-01-01', to: '2026-12-31', groupBy: 'item' });
    expect(body(salesSummary(st, VAT, { from: '2025-01-01', to: '2026-12-31', groupBy: 'item' })).length).toBeGreaterThan(1);
    expect(sum(m, 'total')).toBe(oracle(NV, ['IV', 'TI', 'DN', 'CN'], '2025-01-01', '2026-12-31').total);
  });
  it('by dimension: one row per value of the type and the documents without one together; a type is required', () => {
    const m = salesSummary(st, NV, { from: '2025-01-01', to: '2026-12-31', groupBy: 'dimension', dimension: 'project' });
    expect(body(m).map((r) => r.cells.group)).toEqual(expect.arrayContaining(['P-A', 'P-B', 'ไม่ระบุ']));
    expect(err(() => salesSummary(st, NV, { groupBy: 'dimension' }))).toMatchObject({ status: 422 });
    const viaColon = salesSummary(st, NV, { from: '2025-01-01', to: '2026-12-31', groupBy: 'dimension:project' });
    expect(body(viaColon).map((r) => r.cells.group)).toEqual(body(m).map((r) => r.cells.group));
  });
  it('a non-VAT company has no VAT column and no register tie-out; refusals', () => {
    const m = salesSummary(st, NV, { from: '2026-01-01', to: '2026-12-31' });
    expect(m.columns.map((c) => c.key)).not.toContain('vat');
    expect(m.tieOuts!.map((t) => t.labelKey)).toEqual(['reports.sales.tieDocs']);
    expect(err(() => salesSummary(st, VAT, { groupBy: 'colour' }))).toMatchObject({ status: 422 });
    expect(err(() => salesSummary(st, VAT, { from: '2026-05-01', to: '2026-04-01' }))).toMatchObject({ status: 422 });
    expect(err(() => salesSummary(st, VAT, { from: '2026-02-30' }))).toMatchObject({ status: 422 });
  });
  it('defaults to this year, by customer', () => {
    const m = salesSummary(st, VAT, {});
    expect(m.params).toMatchObject({ from: `${today().slice(0, 4)}-01-01`, to: today(), groupBy: 'customer' });
  });
});

describe('ruling 4: purchase summary', () => {
  it.each(GROUPS.flatMap((g) => [[VAT, g], [NV, g]] as const))('%s %j: Σ groups = the grand total = the stored totals of the live PB / PDN, PCN negative, by document date', (co, g) => {
    for (const [from, to] of RANGES) {
      const m = purchaseSummary(st, co, { from, to, ...g });
      const o = oracle(co, ['PB', 'PDN', 'PCN'], from, to);
      expect(sum(m, 'net'), `${from}..${to}`).toBe(o.net);
      expect(sum(m, 'vat')).toBe(o.vat);
      expect(sum(m, 'total')).toBe(o.total);
      expect(toSatang(grand(m).total)).toBe(o.total);
      expect(m.tieOuts!.every((t) => t.diff === '0.00'), JSON.stringify(m.tieOuts)).toBe(true);
    }
  });
  it('the claimed VAT column is the input VAT register: the register is called for the claim months of the documents (a document counts there by its CLAIM period, not its date)', () => {
    const m = purchaseSummary(st, VAT, { from: '2026-07-01', to: '2026-10-14', groupBy: 'month' });
    const docs = st.docs.filter((d) => d.companyId === VAT && ['PB', 'PDN', 'PCN'].includes(d.type) && LIVE.includes(d.status) && d.header.documentDate >= '2026-07-01');
    const claim = new Set(docs.map((d) => d.header.claimPeriod ?? d.header.documentDate.slice(0, 7)));
    let reg = 0;
    const hrefs = new Set(docs.map((d) => d.id));
    for (const period of claim) for (const r of vatInputRegister(st, VAT, { period }).rows) if (r.kind === 'row' && [...hrefs].some((id) => r.href?.endsWith(id))) reg += toSatang(r.cells.vat);
    expect(toSatang(grand(m).claim)).toBe(reg);
    expect(m.tieOuts!.find((t) => t.labelKey === 'reports.purchases.tieVat')).toMatchObject({ diff: '0.00' });
    expect(m.notes!.join(' ')).toContain('วันที่เอกสาร');
  });
  it('a vendor credit note is negative; the vendor is its id', () => {
    const o = oracle(VAT, ['PCN'], '2025-01-01', '2026-12-31');
    expect(o.total).toBeLessThan(0);
    const m = purchaseSummary(st, VAT, { from: '2025-01-01', to: '2026-12-31', groupBy: 'customer' });
    expect(body(m).every((r) => /^V\d+ /.test(r.cells.group))).toBe(true);
  });
  it('a non-VAT company has no claim column (and keeps the VAT its vendors billed)', () => {
    const m = purchaseSummary(st, NV, {});
    expect(m.columns.map((c) => c.key)).not.toContain('claim');
    expect(m.columns.map((c) => c.key)).toContain('vat');
    expect(m.kind).toBe('purchase-summary');
  });
});
