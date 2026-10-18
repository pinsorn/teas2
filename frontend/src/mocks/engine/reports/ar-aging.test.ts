import { beforeEach, describe, expect, it } from 'vitest';
import type { ReportModel } from '@/domain/reports';
import type { Actor, Doc } from '@/domain/types';
import { buildSeedState, type MockState } from '../../store';
import { cancel, createDraft, issue, revise } from '../commands';
import { correctionPlan, executePlan } from '../corrections';
import { companyEntries } from '../ledger';
import { today } from '../log';
import { toSatang } from '../money';
import { apAging } from './ap-aging';
import { agingReport, arAging } from './ar-aging';

const ME: Actor = { kind: 'user', id: 'u-1', name: 'สมศรี บัญชีดี' };
const VAT = 'co-vat', NV = 'co-nonvat';
let st: MockState;
beforeEach(() => { localStorage.clear(); st = buildSeedState(); });

const groups = (m: ReportModel) => m.rows.filter((r) => r.kind === 'group');
const items = (m: ReportModel) => m.rows.filter((r) => r.kind === 'row');
const total = (m: ReportModel) => m.rows.find((r) => r.kind === 'total')!.cells;
/** The row of one document in a report: which bucket holds it and how much. */
const where = (m: ReportModel, number: string) => {
  const r = items(m).find((x) => x.cells.party === number);
  if (!r) return undefined;
  const k = (['b0', 'b1', 'b2', 'b3', 'b4'] as const).find((b) => r.cells[b]);
  return k ? { bucket: k, amount: r.cells[k] } : { bucket: undefined, amount: r.cells.total };
};
/** Every tie-out of the report, and every per-party difference, must read 0.00. */
const noDiff = (m: ReportModel, label = '') => {
  expect(m.tieOuts!.map((t) => [t.labelKey, t.diff]).filter(([, d]) => d !== '0.00'), `tie-outs ${label}`).toEqual([]);
  expect(m.rows.filter((r) => r.cells.diff && r.cells.diff !== '0.00' || r.cells.depDiff && r.cells.depDiff !== '0.00').map((r) => [r.cells.party, r.cells.diff, r.cells.depDiff]), `rows ${label}`).toEqual([]);
};
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const doc = (number: string) => st.docs.find((d) => d.number === number)!;

describe('ruling 2: tie-out of the aging to the ledger', () => {
  it.each([[VAT, 'AR'], [VAT, 'AP'], [NV, 'AR'], [NV, 'AP']] as const)('%s %s: Σ buckets = the ledger per party and in total, deposits = 2140 / 1140, on every date with an entry', (co, side) => {
    const f = side === 'AR' ? arAging : apAging;
    const dates = new Set<string>(['2025-01-01', today()]);
    for (const e of companyEntries(st, co)) { dates.add(e.date); dates.add(addDays(e.date, -1)); }
    for (const d of dates) { if (d >= '2025-01-01') noDiff(f(st, co, { asOf: d }), `${co} ${side} ${d}`); }
  });
  it('the totals are the sum of the parties and of the buckets, and the report names no party without something to show', () => {
    const m = arAging(st, VAT, { asOf: today() });
    const t = total(m);
    expect(toSatang(t.total)).toBe(groups(m).reduce((n, g) => n + toSatang(g.cells.total), 0));
    expect(toSatang(t.total)).toBe(['b0', 'b1', 'b2', 'b3', 'b4'].reduce((n, b) => n + toSatang(t[b]), 0));
    expect(groups(m).filter((g) => ['b0', 'b1', 'b2', 'b3', 'b4', 'deposit', 'gl'].every((k) => toSatang(g.cells[k]) === 0))).toEqual([]);
    expect(m.tieOuts!.map((x) => x.labelKey)).toEqual(['reports.arap.arTie', 'reports.arap.arTieNoParty', 'reports.arap.arTieDep', 'reports.arap.arTieDepNoParty']);
  });
  it('a balance on 1130 / 2140 with no party is its own tie-out line, not hidden and not spread over a party', () => {
    // a defensive line: no command can post it (a JV on a control account is refused, an opening balance posts per party), so the books are tampered with directly
    const e = st.journals.find((j) => j.docId === doc('TI-202610-0002').id)!.preview.entries[0];
    const l = e.lines.find((x) => x.accountCode === '1130')!;
    const { partyName: _n, partyId: _i, ...bare } = l; void _n; void _i;
    e.lines = e.lines.map((x) => (x === l ? bare : x));
    const m = arAging(st, VAT, { asOf: today() });
    const noParty = m.tieOuts!.find((t) => t.labelKey === 'reports.arap.arTieNoParty')!;
    expect(noParty).toMatchObject({ left: '10700.00', right: '0.00', diff: '10700.00' });
    expect(m.tieOuts!.find((t) => t.labelKey === 'reports.arap.arTie')!.diff).toBe('10700.00'); // the document's open item is still listed; the ledger no longer has it under the party
  });
  it('2140 without a party is its own line too (AP: 1140)', () => {
    const e = st.journals.find((j) => j.docId === doc('RC-202610-0005').id)!.preview.entries[0];
    e.lines = e.lines.map((x) => { if (x.accountCode !== '2140') return x; const { partyName: _n, partyId: _i, ...bare } = x; void _n; void _i; return bare; });
    const m = arAging(st, VAT, { asOf: today() });
    expect(m.tieOuts!.find((t) => t.labelKey === 'reports.arap.arTieDepNoParty')).toMatchObject({ left: '-5000.00', diff: '-5000.00' });
    expect(m.tieOuts!.find((t) => t.labelKey === 'reports.arap.arTieDep')!.diff).toBe('-5000.00');
  });
});

describe('ruling 2: buckets', () => {
  // a seed invoice nobody has touched (no receipt, no note): the only thing that moves it between buckets is the date
  const untouched = () => st.docs.find((d) => d.companyId === VAT && d.type === 'TI' && d.status === 'issued' && !!d.header.dueDate && d.header.dueDate !== d.header.documentDate && !st.links.some((l) => l.to === d.id))!;
  it.each([
    ['due', -1, 'b0'], ['due', 0, 'b0'], ['due', 1, 'b1'], ['due', 30, 'b1'], ['due', 31, 'b2'], ['due', 60, 'b2'], ['due', 61, 'b3'], ['due', 90, 'b3'], ['due', 91, 'b4'],
    ['document', 0, 'b0'], ['document', 30, 'b1'], ['document', 31, 'b2'], ['document', 90, 'b3'], ['document', 91, 'b4'],
  ] as const)('basis %s: %i days after the date -> %s (exactly 30 is 1-30; due today is not yet due)', (basis, n, bucket) => {
    const d = untouched();
    const base = basis === 'due' ? d.header.dueDate! : d.header.documentDate;
    expect(where(arAging(st, VAT, { asOf: addDays(base, n), basis }), d.number!)).toMatchObject({ bucket, amount: d.totals.total });
  });
  it('the default basis is the due date, and the two bases differ for an invoice with a term', () => {
    const d = untouched();
    const asOf = addDays(d.header.dueDate!, 10);
    const def = arAging(st, VAT, { asOf }), byDoc = arAging(st, VAT, { asOf, basis: 'document' });
    expect(def.params.basis).toBe('due');
    expect(where(def, d.number!)!.bucket).toBe('b1');
    const days = (m: ReportModel) => Number(items(m).find((x) => x.cells.party === d.number)!.cells.days);
    expect(days(def)).toBe(10);
    expect(days(byDoc)).toBe(10 + (Date.parse(d.header.dueDate!) - Date.parse(d.header.documentDate)) / 86_400_000);
    expect(byDoc.params.basis).toBe('document');
  });
  it('the seed fills every bucket on the receivable side and the payable side has the rest from the other company', () => {
    const ar = total(arAging(st, VAT, { asOf: today() }));
    for (const b of ['b0', 'b1', 'b2', 'b3', 'b4']) expect(toSatang(ar[b]), `AR ${b}`).toBeGreaterThan(0);
    const ap = [total(apAging(st, VAT, { asOf: today() })), total(apAging(st, NV, { asOf: today() }))];
    for (const b of ['b1', 'b2', 'b3', 'b4']) expect(ap.some((t) => toSatang(t[b]) > 0), `AP ${b}`).toBe(true);
    expect(ap.some((t) => toSatang(t.b0) > 0)).toBe(true);
  });
  it('a bad basis or date is refused', () => {
    expect(() => arAging(st, VAT, { basis: 'x' })).toThrow();
    expect(() => arAging(st, VAT, { asOf: '2026-02-30' })).toThrow();
  });
});

describe('ruling 2: true as-of (what was outstanding then, from the links in force then)', () => {
  it('before a receipt dated D the invoice is outstanding by the larger amount; from D it is not', () => {
    // RC-202610-0004 (2026-10-13) takes 10,000.00 off TI-202603-0002
    const now = where(arAging(st, VAT, { asOf: '2026-10-14' }), 'TI-202603-0002')!;
    const before = where(arAging(st, VAT, { asOf: '2026-10-12' }), 'TI-202603-0002')!;
    const on = where(arAging(st, VAT, { asOf: '2026-10-13' }), 'TI-202603-0002')!;
    expect(toSatang(before.amount) - toSatang(now.amount)).toBe(1_000_000);
    expect(on.amount).toBe(now.amount);
  });
  it('a receipt in full removes the invoice from the report from its date; a day earlier it is listed in full', () => {
    // RC-202609-0002 (2026-09-11) pays TI-202609-0001 in full
    expect(where(arAging(st, VAT, { asOf: '2026-09-10' }), 'TI-202609-0001')).toMatchObject({ amount: '64200.00' });
    expect(where(arAging(st, VAT, { asOf: '2026-09-11' }), 'TI-202609-0001')).toBeUndefined();
  });
  it('a credit note counts from its own date', () => {
    // CN-202610-0002 (2026-10-09) lowers TI-202605-0005 by 8,966.60
    const a = where(arAging(st, VAT, { asOf: '2026-10-08' }), 'TI-202605-0005')!, b = where(arAging(st, VAT, { asOf: '2026-10-09' }), 'TI-202605-0005')!;
    expect(toSatang(a.amount) - toSatang(b.amount)).toBe(896_660);
  });
  it('a settlement record counts only from its date: the deposit applied on 2026-10-11 pays the invoice of that day, and the receipt that holds the deposit is not there before', () => {
    expect(where(arAging(st, VAT, { asOf: '2026-10-10' }), 'TI-202610-0003')).toBeUndefined(); // not issued yet
    expect(where(arAging(st, VAT, { asOf: '2026-10-11' }), 'TI-202610-0003')).toBeUndefined(); // issued and paid by the deposit that day
    const dep = (asOf: string) => groups(arAging(st, VAT, { asOf })).find((g) => g.cells.party.startsWith('C05'))?.cells;
    expect(dep('2026-10-10')?.deposit).not.toBe('-930.00');
    expect(dep('2026-10-11')?.deposit).toBe('-930.00'); // 2,000.00 kept less the 1,070.00 applied
    noDiff(arAging(st, VAT, { asOf: '2026-10-10' })); noDiff(arAging(st, VAT, { asOf: '2026-10-11' }));
  });
  it('a receipt cancelled later does not reach back: it is in force on the dates between, and the books tie on every one', () => {
    const ti = createDraft(st, VAT, 'TI', { header: { partyId: 'pc-04', documentDate: '2026-10-01', dueDate: '2026-10-31' }, lines: [{ id: 'l1', description: 'x', qty: '1', unit: 'งาน', unitPrice: '1000', taxCode: 'S7' }] }, ME, 'k-ti');
    const t = issue(st, ti.id, ti.version, ME);
    const rc = createDraft(st, VAT, 'RC', { header: { partyId: 'pc-04', documentDate: '2026-10-05' }, lines: [], allocations: [{ targetId: t.id, targetType: 'TI', amount: '400.00' }] }, ME, 'k-rc');
    const r = issue(st, rc.id, rc.version, ME);
    cancel(st, r.id, r.version, 'other', 'ทดสอบ', ME); // reversed today (2026-10-14)
    const at = (d: string) => where(arAging(st, VAT, { asOf: d }), t.number!)!.amount;
    expect(at('2026-10-04')).toBe('1070.00');
    expect(at('2026-10-05')).toBe('670.00'); // the receipt, in force
    expect(at('2026-10-13')).toBe('670.00'); // still: it was cancelled on the 14th
    expect(at('2026-10-14')).toBe('1070.00');
    for (const d of ['2026-10-04', '2026-10-05', '2026-10-13', '2026-10-14']) noDiff(arAging(st, VAT, { asOf: d }), d);
  });
  /** Corrects a receipt's allocation the way the screens do: the old one is cancelled and a new one issued (a receipt is a tax document, it is never revised in place). */
  const reissue = (rc: Doc, amount: string) => {
    const plan = correctionPlan(st, rc.id, { header: rc.header, lines: [], allocations: [{ ...rc.allocations![0], amount }] }, 'accountant');
    executePlan(st, plan.planId, plan.planHash, ME);
  };
  it('a receipt corrected after the fact (cancelled and issued anew): the books tie on every date, before and after', () => {
    const ti = createDraft(st, VAT, 'TI', { header: { partyId: 'pc-04', documentDate: '2026-10-01', dueDate: '2026-10-31' }, lines: [{ id: 'l1', description: 'x', qty: '1', unit: 'งาน', unitPrice: '1000', taxCode: 'S7' }] }, ME, 'k-ti2');
    const t = issue(st, ti.id, ti.version, ME);
    const rc = createDraft(st, VAT, 'RC', { header: { partyId: 'pc-04', documentDate: '2026-10-05' }, lines: [], allocations: [{ targetId: t.id, targetType: 'TI', amount: '400.00' }] }, ME, 'k-rc2');
    const r = issue(st, rc.id, rc.version, ME);
    reissue(r, '700.00');
    expect(where(arAging(st, VAT, { asOf: '2026-10-14' }), t.number!)!.amount).toBe('370.00');
    for (const d of ['2026-10-04', '2026-10-05', '2026-10-06', '2026-10-13', '2026-10-14']) noDiff(arAging(st, VAT, { asOf: d }), d);
  });
  it('a receipt dated in a CLOSED month and corrected later (the reversal posts late): the books still tie on every date', () => {
    reissue(doc('RC-202606-0002'), '5000.00'); // 2026-06-22, closed; paid TI-202606-0002 8,239.00
    for (const d of ['2026-06-21', '2026-06-22', '2026-06-30', '2026-07-01', '2026-10-13', '2026-10-14']) noDiff(arAging(st, VAT, { asOf: d }), d);
  });
  it('an invoice revised in place (L-class) keeps the books tied on every date', () => {
    const pb = doc('IV-202610-0001');
    revise(st, pb.id, { header: pb.header, lines: pb.lines.map((l, i) => (i === 0 ? { ...l, unitPrice: String(Number(l.unitPrice) + 100) } : l)) }, pb.version, 'x', ME);
    for (const d of ['2026-10-01', '2026-10-12', '2026-10-13', '2026-10-14']) noDiff(arAging(st, NV, { asOf: d }), d);
    expect(where(arAging(st, NV, { asOf: '2026-10-14' }), 'IV-202610-0001')!.amount).toBe(doc('IV-202610-0001').totals.total); // the STORED total of the revision
    expect(doc('IV-202610-0001').totals.total).not.toBe(pb.totals.total);
  });
  it('a cancelled seed document is read as it stood: the replaced invoice and its reissue are never both open', () => {
    for (const d of ['2026-08-05', '2026-08-06', '2026-08-07', '2026-05-27', '2026-05-28', '2026-01-14', '2026-01-15']) noDiff(arAging(st, VAT, { asOf: d }), d);
  });
});

describe('ruling 2: deposits are a separate negative column', () => {
  it('a customer with a deposit has it beside the buckets, never netted: total = Σ buckets, the deposit is its own figure and ties to 2140', () => {
    const m = arAging(st, VAT, { asOf: today() });
    const g = groups(m).find((x) => x.cells.party.startsWith('C08'))!;
    expect(g.cells).toMatchObject({ total: '3210.00', deposit: '-5000.00', depDiff: '0.00' });
    expect(total(m).deposit).toBe('-5930.00');
  });
  it('the payable side mirrors with prepayments (1140): the vendor with a prepayment has a negative column that ties', () => {
    const m = apAging(st, VAT, { asOf: today() });
    expect(groups(m).find((x) => x.cells.party.startsWith('V05'))!.cells).toMatchObject({ total: '1070.00', deposit: '-3000.00', depDiff: '0.00' });
    expect(m.tieOuts!.map((x) => x.labelKey)).toEqual(['reports.arap.apTie', 'reports.arap.apTieNoParty', 'reports.arap.apTieDep', 'reports.arap.apTieDepNoParty']);
  });
});

describe('ruling 1: the party is its id', () => {
  it('a rename moves nothing: same rows under the new name', () => {
    const before = arAging(st, VAT, { asOf: today() });
    st.parties.find((p) => p.id === 'pc-10')!.name = 'ชื่อใหม่ จำกัด';
    const after = arAging(st, VAT, { asOf: today() });
    expect(groups(after).find((g) => g.cells.party.startsWith('C10'))!.cells.party).toBe('C10 ชื่อใหม่ จำกัด');
    const key = (m: ReportModel) => items(m).map((r) => JSON.stringify(r.cells)).sort();
    expect(key(after)).toEqual(key(before));
    noDiff(after);
  });
  it('two parties with the same name are two rows, each tied to its own ledger', () => {
    st.parties.find((p) => p.id === 'pc-07')!.name = st.parties.find((p) => p.id === 'pc-09')!.name;
    const m = arAging(st, VAT, { asOf: today() });
    expect(groups(m).filter((g) => g.cells.party.endsWith('คุณวิชัย ใจดี'))).toHaveLength(2);
    noDiff(m);
  });
  it('another company has none of these parties', () => {
    expect(groups(arAging(st, NV, { asOf: today() })).every((g) => !g.cells.party.startsWith('C10'))).toBe(true);
  });
  it('a document row carries the document link; a party row links to its statement by id', () => {
    const m = arAging(st, VAT, { asOf: today() });
    expect(items(m).find((r) => r.cells.party === 'TI-202609-0006')!.href).toMatch(/tax-invoices\/.+/);
    expect(groups(m)[0].href).toContain('party=pc-');
  });
});

describe('the report model', () => {
  it('columns, kind and the default date', () => {
    const m = agingReport('AR', st, VAT, {});
    expect(m).toMatchObject({ kind: 'ar-aging', asOf: today(), params: { asOf: today(), basis: 'due' } });
    expect(m.columns.map((c) => c.key)).toEqual(['party', 'docDate', 'dueDate', 'days', 'b0', 'b1', 'b2', 'b3', 'b4', 'total', 'deposit', 'gl', 'diff', 'depDiff']);
    expect(apAging(st, VAT, {}).kind).toBe('ap-aging');
  });
});
