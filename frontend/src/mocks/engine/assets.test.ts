import { beforeEach, describe, expect, it } from 'vitest';
import type { Actor, DocLine } from '@/domain/types';
import { buildSeedState, type MockState } from '../store';
import { cancel, createDraft, issue, revise } from './commands';
import { derivedLocks } from './locks';
import { checkInvariants } from './invariants';
import type { MockError } from './log';
import { toSatang } from './money';
import { activateAsset, disposeAsset, liveDps, monthAmount, planDepreciation, previewDepreciation, reverseDisposal, reviseAsset, reviseDp, runDepreciation, unregisteredCapex } from './assets';
import { correctionPlan } from './corrections';
import { obProblem } from './opening';

const ME: Actor = { kind: 'user', id: 'u-1', name: 'สมศรี บัญชีดี' };
const CO = 'co-vat';
let st: MockState, n = 0;
/** The seed registers assets and runs depreciation for the fixtures; these tests want a company with only their own. */
const blank = () => {
  const gone = new Set(st.docs.filter((d) => d.type === 'FA' || d.type === 'DP' || d.header.disposal).map((d) => d.id)); // assets, runs and the invoices of the sales
  for (const d of st.docs) if (gone.has(d.id) && d.header.disposal) st.series[`${d.companyId}|${d.type}|${d.header.documentDate.slice(0, 7)}`] -= 1; // the number the sale's invoice took
  st.docs = st.docs.filter((d) => !gone.has(d.id)); st.journals = st.journals.filter((j) => !gone.has(j.docId));
  st.series = Object.fromEntries(Object.entries(st.series).filter(([k]) => !/\|(FA|DP)\|/.test(k)));
};
beforeEach(() => { localStorage.clear(); st = buildSeedState(); blank(); });

const err = (fn: () => unknown): MockError => { try { fn(); } catch (e) { return e as MockError; } throw new Error('expected a refusal'); };
const doc = (id: string) => st.docs.find((d) => d.id === id)!;
const sat = (m: string) => toSatang(m);

/** An issued bill with one capex line (category 'capex-equipment' -> 1210, VAT claimed). */
const capexBill = (price = '36000.00', date = '2026-07-01', category = 'capex-equipment') => {
  const line: DocLine = { id: `cl-${++n}`, description: 'เครื่องพิมพ์', qty: '1', unit: 'เครื่อง', unitPrice: price, taxCode: 'S7', expenseCategory: category };
  const d = createDraft(st, CO, 'PB', { header: { documentDate: date, partyId: 'pv-10', vendorDocNumber: `CAP-${n}`, vendorDocDate: date }, lines: [line] }, ME, `k${++n}`);
  return { bill: issue(st, d.id, d.version, ME), line };
};
const register = (b = capexBill(), over: Record<string, unknown> = {}) =>
  activateAsset(st, CO, { source: { kind: 'bill', docId: b.bill.id, lineId: b.line.id }, lifeMonths: 36, startDate: '2026-08-15', ...over }, ME);

describe('the monthly amount (ruling 3)', () => {
  const a = { cost: '36000.00', salvage: '0.00', lifeMonths: 36, startDate: '2026-08-15' };
  it('prorates the start month by the days used (15 Aug of 31 days = 17 days) and takes whole months after', () => {
    expect(monthAmount(a, '2026-07', 0)).toBe(0); // not in service yet
    expect(monthAmount(a, '2026-08', 0)).toBe(sat('548.39')); // round(1000.00 x 17 / 31)
    expect(monthAmount(a, '2026-09', 0)).toBe(sat('1000.00'));
  });
  it('the closing month takes the remainder, never beyond cost - salvage', () => {
    // 36 months from 15 Aug 2026: the tail month is the 37th (Aug 2029); what is left is 36000 - 548.39 - 35 x 1000 = 451.61
    expect(monthAmount(a, '2029-08', sat('35548.39'))).toBe(sat('451.61'));
    expect(monthAmount(a, '2029-09', sat('36000.00'))).toBe(0);
    expect(monthAmount(a, '2027-01', sat('35999.00'))).toBe(sat('1.00')); // the cap: only 1.00 is left
  });
  it('a start on the 1st has no partial month: the last full month takes the rounding remainder', () => {
    const b = { cost: '10000.00', salvage: '1.00', lifeMonths: 3, startDate: '2026-01-01' }; // 9999.00 / 3 = 3333.00
    expect(monthAmount(b, '2026-01', 0)).toBe(sat('3333.00'));
    const c = { cost: '10000.00', salvage: '0.00', lifeMonths: 3, startDate: '2026-01-01' }; // 3333.33 x 2, the last = 3333.34
    expect(monthAmount(c, '2026-02', sat('3333.33'))).toBe(sat('3333.33'));
    expect(monthAmount(c, '2026-03', sat('6666.66'))).toBe(sat('3333.34'));
  });
  it('days half away from zero; a disposal month counts the days up to the disposal date', () => {
    const d = { cost: '1000.00', salvage: '0.00', lifeMonths: 10, startDate: '2026-01-01' }; // 100.00 a month
    expect(monthAmount(d, '2026-02', 0, 10)).toBe(sat('35.71')); // 100.00 x 10 / 28 = 35.714
    expect(monthAmount({ ...d, cost: '0.50' }, '2026-02', 0, 15)).toBe(sat('0.03')); // 0.05 x 15 / 28 = 0.0268 -> 0.03
    expect(monthAmount(a, '2026-08', 0, 20)).toBe(sat('193.55')); // 15..20 Aug = 6 days of the 31: 1000.00 x 6 / 31 = 193.548
  });
});

describe('registering an asset from a bill line (ruling 1, 2)', () => {
  it('freezes cost (the net the bill capitalised), salvage, life, start, class and the four account codes; posts nothing', () => {
    const b = capexBill('36000.00');
    const before = JSON.stringify(st.journals.filter((j) => j.docId === b.bill.id));
    const fa = register(b, { salvage: '1.00', name: 'เครื่องพิมพ์ชั้น 2' });
    expect(fa).toMatchObject({ type: 'FA', status: 'issued', correctionClass: 'L' });
    expect(fa.number).toMatch(/^FA-\d{6}-0001$/);
    expect(fa.asset).toMatchObject({ name: 'เครื่องพิมพ์ชั้น 2', assetClass: 'equipment', cost: '36000.00', salvage: '1.00', lifeMonths: 36, method: 'straight_line', startDate: '2026-08-15', depFrom: '2026-08',
      opening: '0.00', accumulated: '0.00', nbv: '36000.00', source: { kind: 'bill', docId: b.bill.id, lineId: b.line.id }, codes: { cost: '1210', accumulated: '1211', expense: '5300', gain: '4210', loss: '5500' } });
    expect(fa.totals.total).toBe('36000.00');
    expect(st.journals.find((j) => j.docId === fa.id)).toBeUndefined();
    expect(JSON.stringify(st.journals.filter((j) => j.docId === b.bill.id))).toBe(before);
    expect(checkInvariants(st)).toEqual([]);
  });
  it('cost includes the VAT that cannot be claimed (the bill capitalised it)', () => {
    const b = capexBill('10000.00');
    const d = doc(b.bill.id); d.header.inputVatForfeited = true; // claim window closed: the bill posted net + VAT to 1210
    expect(register(b).asset!.cost).toBe('10700.00');
  });
  it('the cost and codes do not follow later changes to the chart or the category (frozen)', () => {
    const fa = register();
    st.postingRules.find((r) => r.companyId === CO && r.role === 'FixedAsset' && r.key === 'equipment')!.accountCode = '1220';
    expect(doc(fa.id).asset!.codes.cost).toBe('1210');
  });
  it('one live asset per bill line; the exit is to cancel the asset', () => {
    const b = capexBill();
    const fa = register(b);
    expect(err(() => register(b)).code).toBe('fa.source_taken');
    cancel(st, fa.id, fa.version, 'OTHER', 'ทดสอบ', ME);
    expect(register(b).asset!.cost).toBe('36000.00'); // the line is free again
  });
  it('a line that is not a capex line, or a document that is not a PB / PV, is not a source', () => {
    const e = capexBill('500.00', '2026-10-09', 'supplies');
    expect(err(() => register(e)).code).toBe('fa.source_invalid');
    expect(err(() => activateAsset(st, CO, { source: { kind: 'bill', docId: 'pb-ins', lineId: 'pb-ins-l1' }, lifeMonths: 12 }, ME)).code).toBe('fa.source_invalid');
    expect(err(() => activateAsset(st, CO, { source: { kind: 'bill', docId: 'nope', lineId: 'x' }, lifeMonths: 12 }, ME)).code).toBe('fa.source_invalid');
  });
  it('refuses nonsense terms: salvage not below cost, life not a whole number of months, a bad start date', () => {
    const b = capexBill('1000.00');
    for (const over of [{ salvage: '1000.00' }, { salvage: '-1.00' }, { lifeMonths: 0 }, { lifeMonths: 2.5 }, { startDate: '2026-02-30' }, { name: '  ' }]) {
      expect(err(() => register(b, over)).code, JSON.stringify(over)).toBe('fa.invalid');
    }
  });
  it('a live credit / debit note on the line makes the cost ambiguous: refused', () => {
    const b = capexBill('2000.00');
    const pcn = createDraft(st, CO, 'PCN', { header: { documentDate: '2026-10-10', refDocId: b.bill.id, reasonCode: 'PRICE_REDUCTION', vendorDocNumber: 'CN-1', vendorDocDate: '2026-10-10' }, lines: [{ ...b.line, id: 'pn1', unitPrice: '100.00', sourceLineId: b.line.id }] }, ME, 'kpcn');
    issue(st, pcn.id, pcn.version, ME);
    expect(err(() => register(b)).code).toBe('fa.source_noted');
  });
});

describe('the register shows the capex lines not yet registered', () => {
  it('lists unregistered bill lines and drops one once an asset is made from it', () => {
    const b = capexBill();
    const key = (r: { source: { kind: string } & Record<string, string> }) => `${r.source.docId}|${r.source.lineId ?? r.source.rowId}`;
    const rows = unregisteredCapex(st, CO);
    expect(rows.map(key)).toContain(`${b.bill.id}|${b.line.id}`);
    expect(rows.find((r) => key(r) === `${b.bill.id}|${b.line.id}`)).toMatchObject({ cost: '36000.00', assetClass: 'equipment', docNumber: doc(b.bill.id).number });
    register(b);
    expect(unregisteredCapex(st, CO).map(key)).not.toContain(`${b.bill.id}|${b.line.id}`);
  });
});

// ---------------------------------------------------------------- depreciation runs

const net = (code: string, ids?: string[]) => st.journals.filter((j) => doc(j.docId)?.companyId === CO && (!ids || ids.includes(j.docId))).flatMap((j) => j.preview.entries).flatMap((e) => e.lines).filter((l) => l.accountCode === code).reduce((a, l) => a + sat(l.debit) - sat(l.credit), 0);

describe('a depreciation run (ruling 3)', () => {
  it('previews per-asset rows (the start month prorated) and posts [DepreciationExpense, sum][AccumulatedDepreciation per class] at month end', () => {
    blank();
    const a = register(capexBill('36000.00'), { name: 'A' }), b = register(capexBill('12000.00'), { name: 'B', lifeMonths: 12, startDate: '2026-08-01' });
    const p = previewDepreciation(st, CO, '2026-08');
    expect(p.rows.map((r) => [r.name, r.amount])).toEqual([['A', '548.39'], ['B', '1000.00']]);
    expect(p.total).toBe('1548.39');
    expect(p.problem).toBeUndefined();
    const dp = runDepreciation(st, CO, '2026-08', ME);
    expect(dp).toMatchObject({ type: 'DP', status: 'issued', header: { documentDate: '2026-08-31' }, totals: { total: '1548.39' }, dp: { month: '2026-08' } });
    expect(dp.number).toMatch(/^DP-202608-0001$/);
    const j = st.journals.find((x) => x.docId === dp.id)!.preview.entries;
    expect(j).toHaveLength(1);
    expect(j[0]).toMatchObject({ date: '2026-08-31', kind: 'original' });
    expect(j[0].postedAt).toBeTruthy();
    expect(j[0].lines.map((l) => [l.accountCode, l.debit, l.credit])).toEqual([['5300', '1548.39', '0.00'], ['1211', '0.00', '1548.39']]);
    expect(doc(a.id).asset).toMatchObject({ accumulated: '548.39', nbv: '35451.61' });
    expect(doc(b.id).asset).toMatchObject({ accumulated: '1000.00', nbv: '11000.00' });
    expect(checkInvariants(st)).toEqual([]);
  });
  it('one run per company-month, in order, only for a month that has ended', () => {
    blank();
    register(capexBill(), { startDate: '2026-07-01' });
    runDepreciation(st, CO, '2026-07', ME);
    expect(err(() => runDepreciation(st, CO, '2026-07', ME)).code).toBe('dp.already_run');
    expect(err(() => runDepreciation(st, CO, '2026-09', ME)).code).toBe('dp.out_of_order'); // August is missing
    expect(err(() => runDepreciation(st, CO, '2026-06', ME)).code).toBe('dp.out_of_order');
    runDepreciation(st, CO, '2026-08', ME); runDepreciation(st, CO, '2026-09', ME);
    expect(err(() => runDepreciation(st, CO, '2026-10', ME)).code).toBe('dp.not_due'); // today is mid-October: October has not ended
    expect(err(() => previewDepreciation(st, CO, '2026-13')).code).toBe('dp.invalid');
    expect(previewDepreciation(st, CO, '2026-10').problem?.code).toBe('dp.not_due'); // the preview says why before the user tries
    expect(liveDps(st, CO).map((d) => d.dp!.month)).toEqual(['2026-07', '2026-08', '2026-09']);
  });
  it('the first run of a company may start at any open month; a closed month is refused with the reopen exit', () => {
    blank();
    register(capexBill(), { startDate: '2026-08-01' });
    expect(err(() => runDepreciation(st, CO, '2026-06', ME)).code).toBe('period.closed');
    expect(runDepreciation(st, CO, '2026-08', ME).dp!.month).toBe('2026-08');
  });
  it('an asset that was due in an earlier month nobody ran is not silently skipped', () => {
    blank();
    register(capexBill(), { startDate: '2026-07-01' });
    expect(err(() => runDepreciation(st, CO, '2026-09', ME)).code).toBe('dp.asset_behind'); // July and August were never run
    runDepreciation(st, CO, '2026-07', ME); runDepreciation(st, CO, '2026-08', ME);
    expect(runDepreciation(st, CO, '2026-09', ME).dp!.rows).toHaveLength(1);
  });
  it('never beyond cost - salvage: the last run takes the remainder, then the asset drops out of the runs', () => {
    blank();
    const a = register(capexBill('1000.00'), { lifeMonths: 3, startDate: '2026-07-01', salvage: '1.00' }); // 999.00 / 3 = 333.00
    for (const m of ['2026-07', '2026-08', '2026-09']) runDepreciation(st, CO, m, ME);
    expect(doc(a.id).asset).toMatchObject({ accumulated: '999.00', nbv: '1.00' });
    expect(previewDepreciation(st, CO, '2026-10').rows).toEqual([]);
  });
  it('an empty month is a run too (it keeps the months consecutive) and posts nothing', () => {
    blank();
    register(capexBill(), { startDate: '2026-09-01' });
    const e = runDepreciation(st, CO, '2026-07', ME); // before the asset starts
    expect(e.dp!.rows).toEqual([]); expect(e.totals.total).toBe('0.00');
    expect(st.journals.find((j) => j.docId === e.id)).toBeUndefined();
    runDepreciation(st, CO, '2026-08', ME);
    expect(runDepreciation(st, CO, '2026-09', ME).dp!.rows).toHaveLength(1);
    expect(checkInvariants(st)).toEqual([]);
  });
  it('freezes the rows: a later change of the asset or the chart moves neither the run nor its journal', () => {
    blank();
    const a = register(capexBill('12000.00'), { lifeMonths: 12, startDate: '2026-07-01', name: 'A' });
    const dp = runDepreciation(st, CO, '2026-07', ME);
    doc(a.id).asset!.codes.expense = '5100'; doc(a.id).asset!.name = 'renamed';
    expect(doc(dp.id).dp!.rows[0]).toMatchObject({ name: 'A', amount: '1000.00', expenseCode: '5300' });
    expect(st.journals.find((j) => j.docId === dp.id)!.preview.entries[0].lines[0].accountCode).toBe('5300');
  });
});

describe('cancelling and revising a run (ruling 3)', () => {
  it('only the latest live run can be cancelled; the reversal gives the accumulated back and the month can run again', () => {
    blank();
    const a = register(capexBill('12000.00'), { lifeMonths: 12, startDate: '2026-07-01' });
    const jul = runDepreciation(st, CO, '2026-07', ME), aug = runDepreciation(st, CO, '2026-08', ME);
    expect(err(() => cancel(st, jul.id, jul.version, 'OTHER', 'x', ME)).code).toBe('dp.not_latest');
    cancel(st, aug.id, aug.version, 'OTHER', 'ผิดงวด', ME);
    expect(doc(a.id).asset!.accumulated).toBe('1000.00');
    const j = st.journals.find((x) => x.docId === aug.id)!.preview.entries;
    expect(j.map((e) => e.kind)).toEqual(['original', 'reversal']);
    expect(net('1211', [aug.id])).toBe(0);
    expect(runDepreciation(st, CO, '2026-08', ME).dp!.rows[0].amount).toBe('1000.00');
    expect(checkInvariants(st)).toEqual([]);
  });
  it('revise (latest only) recomputes from the frozen asset data as it is now: reverse and repost', () => {
    blank();
    const a = register(capexBill('12000.00'), { lifeMonths: 12, startDate: '2026-07-01' });
    const jul = runDepreciation(st, CO, '2026-07', ME);
    doc(a.id).asset!.lifeMonths = 6; // the frozen figure the run reads (a test-only change: the engine locks it once a run exists)
    const r = reviseDp(st, jul.id, ME);
    expect(r.dp!.rows[0].amount).toBe('2000.00'); expect(r).toMatchObject({ revision: 1, totals: { total: '2000.00' } });
    expect(st.journals.find((x) => x.docId === jul.id)!.preview.entries.map((e) => e.kind)).toEqual(['original', 'reversal', 'correction']);
    expect(doc(a.id).asset!.accumulated).toBe('2000.00');
    doc(a.id).asset!.lifeMonths = 12;
    runDepreciation(st, CO, '2026-08', ME);
    expect(err(() => reviseDp(st, jul.id, ME)).code).toBe('dp.not_latest');
  });
});

// ---------------------------------------------------------------- disposal

const lines = (docId: string, kind = 0) => st.journals.find((j) => j.docId === docId)!.preview.entries[kind].lines.map((l) => [l.accountCode, l.debit, l.credit] as [string, string, string]);
/** 36,000.00 over 36 months from 15 Aug 2026; August and September run: accumulated 1,548.39. */
const runAsset = (price = '36000.00') => {
  blank();
  const fa = register(capexBill(price));
  runDepreciation(st, CO, '2026-08', ME); runDepreciation(st, CO, '2026-09', ME);
  return fa;
};

describe('disposal by sale (ruling 4)', () => {
  it('issues a tax invoice through the normal path; its journal removes exactly the frozen cost and accumulated; the disposal-month partial is in the entry', () => {
    const fa = runAsset();
    const out = disposeAsset(st, CO, fa.id, { date: '2026-10-10', kind: 'sale', proceeds: '30000.00', buyerId: 'pc-01' }, ME);
    const d = out.asset!.disposed!;
    expect(d).toMatchObject({ date: '2026-10-10', kind: 'sale', cost: '36000.00', partial: '322.58', accumulated: '1870.97', nbv: '34129.03', proceeds: '30000.00', vat: '2100.00', outcome: 'loss', gainLoss: '4129.03' });
    const ti = doc(d.tiId!);
    expect(ti).toMatchObject({ type: 'TI', status: 'issued', totals: { net: '30000.00', vat: '2100.00', total: '32100.00' }, header: { partyId: 'pc-01', documentDate: '2026-10-10' } });
    expect(ti.number).toMatch(/^TI-/);
    expect(ti.header.disposal).toMatchObject({ faId: fa.id, accumulated: '1870.97', cost: '36000.00' });
    expect(lines(ti.id)).toEqual([['1130', '32100.00', '0.00'], ['1211', '1870.97', '0.00'], ['5300', '322.58', '0.00'], ['1211', '0.00', '322.58'], ['5500', '4129.03', '0.00'], ['1210', '0.00', '36000.00'], ['2151', '0.00', '2100.00']]);
    expect(st.journals.find((j) => j.docId === ti.id)!.preview.entries[0].lines[0].partyName).toBe(ti.party!.name); // the AR line is the buyer's
    expect(out.asset).toMatchObject({ accumulated: '1870.97', nbv: '34129.03' });
    expect(st.journals.find((j) => j.docId === fa.id)).toBeUndefined(); // the sale's entry is the invoice's
    expect(ti.outstanding).toBe('32100.00'); // a normal, settleable receivable (invariants 4 / 4b)
    expect(checkInvariants(st)).toEqual([]);
  });
  it('a gain posts to the gain account; the net effect on the asset accounts is exactly the asset', () => {
    const fa = runAsset();
    const out = disposeAsset(st, CO, fa.id, { date: '2026-10-10', kind: 'sale', proceeds: '40000.00', buyerId: 'pc-01' }, ME);
    expect(out.asset!.disposed).toMatchObject({ outcome: 'gain', gainLoss: '5870.97', vat: '2800.00' });
    const ls = lines(out.asset!.disposed!.tiId!);
    expect(ls).toContainEqual(['4210', '0.00', '5870.97']);
    const mine = [fa.asset!.source.docId, out.asset!.disposed!.tiId!, ...liveDps(st, CO).map((d) => d.id)];
    expect(net('1210', mine)).toBe(0); expect(net('1211', mine)).toBe(0); // the bill's debit and the runs' credits are all taken out again
    expect(checkInvariants(st)).toEqual([]);
  });
  it('a company outside VAT sells with an IV and no VAT', () => {
    blank();
    const NV = 'co-nonvat';
    const l: DocLine = { id: 'nl1', description: 'โต๊ะทำงาน', qty: '1', unit: 'ตัว', unitPrice: '5000.00', taxCode: 'EX', expenseCategory: 'capex-equipment' };
    const pb = createDraft(st, NV, 'PB', { header: { documentDate: '2026-10-01', partyId: 'nv-01', vendorDocNumber: 'N-1', vendorDocDate: '2026-10-01' }, lines: [l] }, ME, 'knv');
    const issued = issue(st, pb.id, pb.version, ME);
    const fa = activateAsset(st, NV, { source: { kind: 'bill', docId: issued.id, lineId: l.id }, lifeMonths: 10, startDate: '2026-10-01' }, ME);
    const out = disposeAsset(st, NV, fa.id, { date: '2026-10-05', kind: 'sale', proceeds: '4000.00', buyerId: 'nc-01' }, ME);
    const iv = doc(out.asset!.disposed!.tiId!);
    expect(iv).toMatchObject({ type: 'IV', totals: { vat: '0.00', total: '4000.00' } });
    expect(out.asset!.disposed).toMatchObject({ vat: '0.00', partial: '80.65', accumulated: '80.65' }); // 500.00 x 5 / 31
    expect(checkInvariants(st)).toEqual([]);
  });
  it('is refused until every run before the disposal month exists, and while a run for that month or later stands', () => {
    const fa = runAsset();
    expect(err(() => disposeAsset(st, CO, fa.id, { date: '2026-11-03', kind: 'sale', proceeds: '1.00', buyerId: 'pc-01' }, ME)).code).toBe('doc.future_date');
    const dpSep = liveDps(st, CO)[1];
    expect(err(() => disposeAsset(st, CO, fa.id, { date: '2026-09-20', kind: 'write_off' }, ME)).code).toBe('fa.dp_after'); // September is already run
    cancel(st, dpSep.id, dpSep.version, 'OTHER', 'x', ME);
    expect(err(() => disposeAsset(st, CO, fa.id, { date: '2026-10-10', kind: 'write_off' }, ME)).code).toBe('fa.dp_missing'); // September is missing now
    const out = disposeAsset(st, CO, fa.id, { date: '2026-09-20', kind: 'write_off' }, ME);
    expect(out.asset!.disposed).toMatchObject({ partial: '666.67', accumulated: '1215.06' }); // September, 20 of 30 days: 1000.00 x 20 / 30 on top of August's 548.39
  });
  it('refuses a sale without a buyer, without proceeds, a date before the start, and a second disposal', () => {
    const fa = runAsset();
    for (const [over, code] of [[{ buyerId: undefined }, 'fa.invalid'], [{ buyerId: 'pv-01' }, 'fa.invalid'], [{ proceeds: '0.00' }, 'fa.invalid'], [{ proceeds: 'abc' }, 'fa.invalid'], [{ date: '2026-08-01' }, 'fa.dispose_date']] as const) {
      expect(err(() => disposeAsset(st, CO, fa.id, { date: '2026-10-10', kind: 'sale', proceeds: '1000.00', buyerId: 'pc-01', ...(over as object) }, ME)).code, JSON.stringify(over)).toBe(code);
    }
    expect(st.docs.filter((d) => d.type === 'TI' && d.header.disposal).length).toBe(0); // a refused sale leaves no invoice behind
    disposeAsset(st, CO, fa.id, { date: '2026-10-10', kind: 'write_off' }, ME);
    expect(err(() => disposeAsset(st, CO, fa.id, { date: '2026-10-11', kind: 'write_off' }, ME)).code).toBe('fa.already_disposed');
  });
  it('the next run leaves a disposed asset out', () => {
    blank();
    const fa = register(capexBill('36000.00'), { startDate: '2026-08-01' }), other = register(capexBill('12000.00'), { startDate: '2026-08-01', lifeMonths: 12 });
    runDepreciation(st, CO, '2026-08', ME);
    disposeAsset(st, CO, fa.id, { date: '2026-09-10', kind: 'write_off' }, ME);
    expect(runDepreciation(st, CO, '2026-09', ME).dp!.rows.map((r) => r.assetId)).toEqual([other.id]);
  });
});

describe('write-off and undoing a disposal (ruling 4)', () => {
  it('posts [AccumulatedDepreciation][partial depreciation][loss][FixedAsset] on the asset itself; reversing it makes the asset live again', () => {
    const fa = runAsset();
    const out = disposeAsset(st, CO, fa.id, { date: '2026-10-10', kind: 'write_off' }, ME);
    expect(out.asset!.disposed).toMatchObject({ kind: 'write_off', nbv: '34129.03', outcome: 'loss', gainLoss: '34129.03' });
    expect(lines(fa.id)).toEqual([['1211', '1870.97', '0.00'], ['5300', '322.58', '0.00'], ['1211', '0.00', '322.58'], ['5500', '34129.03', '0.00'], ['1210', '0.00', '36000.00']]);
    expect(st.journals.find((j) => j.docId === fa.id)!.preview.entries[0]).toMatchObject({ date: '2026-10-10', kind: 'original' });
    expect(checkInvariants(st)).toEqual([]);
    const back = reverseDisposal(st, CO, fa.id, ME);
    expect(back.asset!.disposed).toBeUndefined(); expect(back.asset).toMatchObject({ accumulated: '1548.39', nbv: '34451.61' });
    expect(st.journals.find((j) => j.docId === fa.id)!.preview.entries.map((e) => e.kind)).toEqual(['original', 'reversal']);
    expect(checkInvariants(st)).toEqual([]);
    expect(disposeAsset(st, CO, fa.id, { date: '2026-10-12', kind: 'write_off' }, ME).asset!.disposed!.date).toBe('2026-10-12'); // and it can be disposed of again
    expect(checkInvariants(st)).toEqual([]);
  });
  it('cancelling the sale invoice reverses the disposal: the asset is live again and the invoice is reversed in the ledger', () => {
    const fa = runAsset();
    const ti = doc(disposeAsset(st, CO, fa.id, { date: '2026-10-10', kind: 'sale', proceeds: '30000.00', buyerId: 'pc-01' }, ME).asset!.disposed!.tiId!);
    cancel(st, ti.id, ti.version, 'OTHER', 'ขายผิดราคา', ME);
    expect(doc(fa.id).asset).toMatchObject({ accumulated: '1548.39', nbv: '34451.61' }); expect(doc(fa.id).asset!.disposed).toBeUndefined();
    expect(st.journals.find((j) => j.docId === ti.id)!.preview.entries.map((e) => e.kind)).toEqual(['original', 'reversal']);
    expect(net('1210', [fa.asset!.source.docId, ti.id])).toBe(sat('36000.00')); expect(net('1130', [ti.id])).toBe(0);
    expect(checkInvariants(st)).toEqual([]);
    expect(disposeAsset(st, CO, fa.id, { date: '2026-10-10', kind: 'sale', proceeds: '31000.00', buyerId: 'pc-01' }, ME).asset!.disposed!.tiId).not.toBe(ti.id); // sold again with a new invoice
  });
  it('a run for the disposal month or later blocks reversing it (exit: reverse that run)', () => {
    blank();
    const fa = register(capexBill('36000.00'), { startDate: '2026-08-01' });
    runDepreciation(st, CO, '2026-08', ME);
    const ti = doc(disposeAsset(st, CO, fa.id, { date: '2026-09-10', kind: 'sale', proceeds: '30000.00', buyerId: 'pc-01' }, ME).asset!.disposed!.tiId!);
    const sep = runDepreciation(st, CO, '2026-09', ME); // excludes the disposed asset
    expect(err(() => cancel(st, ti.id, ti.version, 'OTHER', 'x', ME)).code).toBe('fa.dp_after');
    expect(doc(ti.id).status).toBe('issued');
    cancel(st, sep.id, sep.version, 'OTHER', 'x', ME);
    cancel(st, ti.id, ti.version, 'OTHER', 'x', ME);
    expect(doc(fa.id).asset!.disposed).toBeUndefined();
  });
  it('the sale invoice takes no credit / debit note and no correction plan; the asset and the invoice cannot be cancelled around each other', () => {
    const fa = runAsset();
    const ti = doc(disposeAsset(st, CO, fa.id, { date: '2026-10-10', kind: 'sale', proceeds: '30000.00', buyerId: 'pc-01' }, ME).asset!.disposed!.tiId!);
    const cn = createDraft(st, CO, 'CN', { header: { documentDate: '2026-10-11', refDocId: ti.id, reasonCode: 'PRICE_REDUCTION' }, lines: [{ id: 'c1', description: 'ลดราคา', qty: '1', unit: 'งาน', unitPrice: '100.00', taxCode: 'S7', sourceLineId: ti.lines[0].id }] }, ME, 'kcn');
    expect(err(() => issue(st, cn.id, cn.version, ME)).code).toBe('fa.disposal_note');
    expect(err(() => correctionPlan(st, ti.id, { header: ti.header, lines: [{ ...ti.lines[0], unitPrice: '29000.00' }] }, 'accountant')).code).toBe('fa.disposal_locked');
    expect(err(() => cancel(st, fa.id, doc(fa.id).version, 'OTHER', 'x', ME)).code).toBe('fa.has_disposal');
  });
});

// ---------------------------------------------------------------- sources, locks, editing

describe('the source is locked while a live asset stands on it (ruling 2)', () => {
  it('a bill with a live asset cannot be cancelled or have the capex line changed; a note on the line cannot be issued; the exit is to cancel the asset', () => {
    blank();
    const b = capexBill('36000.00'), fa = register(b);
    const bill = doc(b.bill.id);
    expect(err(() => cancel(st, bill.id, bill.version, 'OTHER', 'x', ME)).code).toBe('fa.source_locked');
    const body = (over: Partial<DocLine>) => ({ header: bill.header, lines: [{ ...bill.lines[0], ...over }] });
    for (const over of [{ unitPrice: '35000.00' }, { qty: '2' }, { expenseCategory: 'supplies' }, { taxCode: 'EX' as const }]) {
      expect(err(() => revise(st, bill.id, body(over), bill.version, 'x', ME)).code, JSON.stringify(over)).toBe('fa.source_locked');
      expect(err(() => correctionPlan(st, bill.id, body(over), 'accountant')).code, `plan ${JSON.stringify(over)}`).toBe('fa.source_locked');
    }
    expect(revise(st, bill.id, body({ description: 'เครื่องพิมพ์ (แก้ชื่อ)' }), bill.version, 'x', ME).lines[0].description).toBe('เครื่องพิมพ์ (แก้ชื่อ)'); // a description is not money
    const pcn = createDraft(st, CO, 'PCN', { header: { documentDate: '2026-10-10', refDocId: bill.id, reasonCode: 'PRICE_REDUCTION', vendorDocNumber: 'CN-9', vendorDocDate: '2026-10-10' }, lines: [{ ...bill.lines[0], id: 'pn9', unitPrice: '100.00', sourceLineId: bill.lines[0].id }] }, ME, 'kpcn9');
    expect(err(() => issue(st, pcn.id, pcn.version, ME)).code).toBe('fa.source_locked');
    const lock = derivedLocks(st, doc(bill.id)).find((l) => l.kind === 'asset')!;
    expect(lock).toMatchObject({ kind: 'asset', href: `/accounting/fixed-assets/${fa.id}` });
    expect(lock.exits[0]).toContain(fa.number);
    cancel(st, fa.id, fa.version, 'OTHER', 'x', ME);
    expect(derivedLocks(st, doc(bill.id)).some((l) => l.kind === 'asset')).toBe(false);
    cancel(st, bill.id, doc(bill.id).version, 'OTHER', 'x', ME); // the bill is free again
  });
  it('an asset made from a PV own capex line costs what the voucher capitalised (a voucher line has no VAT: a line with VAT is a bill)', () => {
    blank();
    const l: DocLine = { id: 'pvl1', description: 'เก้าอี้สำนักงาน', qty: '1', unit: 'ชุด', unitPrice: '10000.00', taxCode: 'EX', expenseCategory: 'capex-equipment' };
    const d = createDraft(st, CO, 'PV', { header: { documentDate: '2026-10-01', partyId: 'pv-10' }, lines: [l] }, ME, 'kpv1');
    const pv = issue(st, d.id, d.version, ME);
    const fa = activateAsset(st, CO, { source: { kind: 'bill', docId: pv.id, lineId: l.id }, lifeMonths: 60, startDate: '2026-10-01' }, ME);
    expect(fa.asset).toMatchObject({ cost: '10000.00', assetClass: 'equipment', codes: { cost: '1210' } });
    expect(err(() => cancel(st, pv.id, doc(pv.id).version, 'OTHER', 'x', ME)).code).toBe('fa.source_locked');
    expect(checkInvariants(st)).toEqual([]);
  });
});

describe('an asset from an opening-balance row (ruling 1, 2)', () => {
  const NV = 'co-nonvat';
  const row = () => { const ob = doc('nob-1'); return { ob, a: ob.opening!.assets[0] }; };
  it('takes cost, opening accumulated, acquisition date and life from the row, and depreciates from the month after the cut-off', () => {
    blank();
    const { ob, a } = row();
    expect(a.id).toBeTruthy(); // the batch gives every asset row an id of its own
    const fa = activateAsset(st, NV, { source: { kind: 'ob', docId: ob.id, rowId: a.id! }, salvage: '1.00' }, ME);
    expect(fa.asset).toMatchObject({ cost: '45000.00', opening: '9000.00', accumulated: '9000.00', nbv: '36000.00', startDate: '2025-03-01', lifeMonths: 60, depFrom: '2026-01', assetClass: 'equipment', salvage: '1.00', codes: { cost: '1210', accumulated: '1211' } });
    expect(fa.party).toBeUndefined();
    expect(err(() => activateAsset(st, NV, { source: { kind: 'ob', docId: ob.id, rowId: a.id! } }, ME)).code).toBe('fa.source_taken');
    expect(unregisteredCapex(st, NV).some((r) => r.source.kind === 'ob')).toBe(false);
  });
  it('the batch cannot be cancelled, or its asset row or cut-off changed, while the asset is live; other revisions pass', () => {
    blank();
    const { ob, a } = row();
    const fa = activateAsset(st, NV, { source: { kind: 'ob', docId: ob.id, rowId: a.id! } }, ME);
    const body = (op: Partial<typeof a>, over: { notes?: string; date?: string } = {}) => ({ header: { ...ob.header, ...(over.notes ? { notes: over.notes } : {}), ...(over.date ? { documentDate: over.date } : {}) }, lines: ob.lines, opening: { ...ob.opening!, assets: [{ ...a, ...op }] } });
    expect(err(() => cancel(st, ob.id, ob.version, 'OTHER', 'x', ME)).code).toBe('fa.source_locked');
    for (const op of [{ cost: '46000.00' }, { accumulated: '9500.00' }, { acquired: '2025-04-01' }, { lifeMonths: 36 }, { assetClass: 'vehicle' }]) {
      expect(err(() => revise(st, ob.id, body(op), ob.version, 'x', ME)).code, JSON.stringify(op)).toBe('fa.source_locked');
    }
    expect(err(() => revise(st, ob.id, { ...body({}), opening: { ...ob.opening!, assets: [] } }, ob.version, 'x', ME)).code).toBe('fa.source_locked'); // the row cannot be dropped
    expect(err(() => revise(st, ob.id, { ...body({ cost: '46000.00' }), opening: { ...ob.opening!, assets: [{ ...a, cost: '46000.00', id: undefined }] } }, ob.version, 'x', ME)).code).toBe('fa.source_locked'); // nor re-created under a new id with other money
    expect(revise(st, ob.id, { ...body({}), opening: { ...ob.opening!, assets: [{ ...a, id: undefined }] } }, ob.version, 'x', ME).opening!.assets[0].id).toBe(a.id); // the same row without its id keeps the id it had
    expect(revise(st, ob.id, body({ name: 'เครื่องพิมพ์ (แก้ชื่อ)' }, { notes: 'แก้หมายเหตุ' }), doc(ob.id).version, 'x', ME).header.notes).toBe('แก้หมายเหตุ');
    expect(derivedLocks(st, doc(ob.id)).some((l) => l.kind === 'asset')).toBe(true);
    cancel(st, fa.id, fa.version, 'OTHER', 'x', ME);
    expect(err(() => revise(st, ob.id, body({ cost: '46000.00' }), doc(ob.id).version, 'x', ME)).code).toBe('ob.subledger_mismatch'); // free of the asset lock once the asset is cancelled: only the batch's own tie to the trial balance judges now
  });
});

describe('invariants: each fails on a single-fault tamper (ruling 5)', () => {
  /** A bill asset A that ran August and September, and an asset B (from a PV line) sold on 20 Sep (its invoice issued) - everything through the real commands. */
  const world = () => {
    blank();
    const a = register(capexBill('36000.00'), { name: 'A', startDate: '2026-08-01' });
    const l: DocLine = { id: 'pvb', description: 'B', qty: '1', unit: 'ชุด', unitPrice: '12000.00', taxCode: 'EX', expenseCategory: 'capex-equipment' };
    const pvd = createDraft(st, CO, 'PV', { header: { documentDate: '2026-09-02', partyId: 'pv-10' }, lines: [l] }, ME, 'kpvw');
    const pv = issue(st, pvd.id, pvd.version, ME);
    const b = activateAsset(st, CO, { source: { kind: 'bill', docId: pv.id, lineId: l.id }, lifeMonths: 12, startDate: '2026-09-02', name: 'B' }, ME);
    runDepreciation(st, CO, '2026-08', ME);
    const sold = disposeAsset(st, CO, b.id, { date: '2026-09-20', kind: 'sale', proceeds: '10000.00', buyerId: 'pc-01' }, ME);
    runDepreciation(st, CO, '2026-09', ME);
    expect(checkInvariants(st)).toEqual([]);
    return { a, b, sold, ti: doc(sold.asset!.disposed!.tiId!), pv, dps: liveDps(st, CO) };
  };
  const fires = (re: RegExp) => { const m = checkInvariants(st).filter((x) => re.test(x)); expect(m, `${re} in ${JSON.stringify(checkInvariants(st))}`).not.toEqual([]); };
  const jv = (docId: string) => st.journals.find((j) => j.docId === docId)!.preview.entries;

  it('accumulated = opening + Σ live run rows (+ partial), and never beyond cost - salvage', () => {
    const { a } = world();
    doc(a.id).asset!.accumulated = '1.00'; fires(/accumulated .* but/);
  });
  it('...the cap', () => {
    const { a } = world();
    doc(a.id).asset!.salvage = '35999.00'; fires(/beyond cost - salvage/);
  });
  it('per class GL(accumulated depreciation) = Σ accumulated of live, undisposed assets (+ the opening rows no asset covers)', () => {
    const { a } = world();
    doc(a.id).asset!.codes.accumulated = '1221'; // the asset reads another account than the one its runs credited
    fires(/GL 1211/);
  });
  it('each run journal is its stored rows', () => {
    const { dps } = world();
    jv(dps[0].id)[0].lines[0].debit = '999.00';
    fires(/journal is not its rows/);
  });
  it('a run row carries the codes the asset froze, and the rows add up to the run total', () => {
    const { dps } = world();
    dps[0].dp!.rows[0].expenseCode = '5100'; fires(/frozen codes/);
  });
  it('...the total', () => {
    const { dps } = world();
    dps[0].totals.total = '1.00'; fires(/run total/);
  });
  it('runs are consecutive months dated at the month end', () => {
    const { dps } = world();
    dps[1].dp!.month = '2026-11'; fires(/consecutive|month end/);
  });
  it('one live asset per source; a live asset stands on a live source', () => {
    const { a } = world();
    st.docs.push({ ...structuredClone(doc(a.id)), id: 'dup', number: 'FA-DUP' }); fires(/more than one live asset/);
    st.docs = st.docs.filter((d) => d.id !== 'dup');
    doc(a.asset!.source.docId).status = 'cancelled'; fires(/source .* is not live/);
  });
  it('a sold asset: its invoice is live, linked both ways, and the invoice is the frozen entry (cost, accumulated, VAT)', () => {
    const { ti, b } = world();
    jv(ti.id)[0].lines.find((l) => l.accountCode === '1210')!.credit = '11999.00'; fires(/disposal entry/);
    jv(ti.id)[0].lines.find((l) => l.accountCode === '1210')!.credit = '12000.00';
    jv(ti.id)[0].lines.find((l) => l.accountCode === '2151')!.credit = '1.00'; fires(/disposal entry/);
    jv(ti.id)[0].lines.find((l) => l.accountCode === '2151')!.credit = '700.00';
    expect(checkInvariants(st)).toEqual([]);
    doc(b.id).asset!.disposed!.vat = '1.00'; fires(/VAT/);
  });
  it('a disposal invoice no asset points at, and an asset pointing at the wrong invoice', () => {
    const { ti, b } = world();
    doc(b.id).asset!.disposed!.tiId = 'nope'; fires(/disposal invoice/);
    doc(b.id).asset!.disposed!.tiId = ti.id;
    doc(ti.id).header.disposal!.faId = 'other'; fires(/disposal invoice/);
  });
  it('the disposed asset: every run before the disposal month exists and none is for that month or later (the asset is out of them)', () => {
    blank();
    const fa = register(capexBill('36000.00'), { startDate: '2026-08-01' });
    runDepreciation(st, CO, '2026-08', ME);
    disposeAsset(st, CO, fa.id, { date: '2026-09-10', kind: 'write_off' }, ME);
    expect(checkInvariants(st)).toEqual([]);
    liveDps(st, CO)[0].status = 'cancelled'; fires(/before the disposal month/);
  });
  it('a write-off carries the frozen entry on the asset; a live asset carries none', () => {
    blank();
    const a = register(capexBill('36000.00'), { startDate: '2026-08-01' });
    runDepreciation(st, CO, '2026-08', ME);
    disposeAsset(st, CO, a.id, { date: '2026-09-10', kind: 'write_off' }, ME);
    expect(checkInvariants(st)).toEqual([]);
    jv(a.id)[0].lines.find((l) => l.accountCode === '1210')!.credit = '35999.00'; fires(/disposal entry/);
    jv(a.id)[0].lines.find((l) => l.accountCode === '1210')!.credit = '36000.00';
    reverseDisposal(st, CO, a.id, ME);
    expect(checkInvariants(st)).toEqual([]);
    jv(a.id).push({ date: '2026-10-01', kind: 'original', postedAt: 'x', lines: [{ accountCode: '1210', accountName: 'x', debit: '5.00', credit: '0.00', rule: 'x' }, { accountCode: '5100', accountName: 'x', debit: '0.00', credit: '5.00', rule: 'x' }] });
    fires(/live asset .* entry/);
  });
});

describe('editing an asset and the guards on registering (ruling 2)', () => {
  it('terms may be edited until a run or a disposal exists; the name always', () => {
    blank();
    const fa = register(capexBill('12000.00'), { lifeMonths: 12, startDate: '2026-07-01' });
    const e = reviseAsset(st, CO, fa.id, { salvage: '100.00', lifeMonths: 6, startDate: '2026-08-01', name: 'ใหม่' }, ME);
    expect(e.asset).toMatchObject({ salvage: '100.00', lifeMonths: 6, startDate: '2026-08-01', depFrom: '2026-08', name: 'ใหม่', cost: '12000.00' });
    expect(e).toMatchObject({ revision: 1 });
    expect(err(() => reviseAsset(st, CO, fa.id, { salvage: '12000.00' }, ME)).code).toBe('fa.invalid');
    runDepreciation(st, CO, '2026-08', ME);
    for (const p of [{ salvage: '0.00' }, { lifeMonths: 12 }, { startDate: '2026-09-01' }]) expect(err(() => reviseAsset(st, CO, fa.id, p, ME)).code, JSON.stringify(p)).toBe('fa.locked');
    expect(reviseAsset(st, CO, fa.id, { name: 'ชื่อใหม่อีกครั้ง' }, ME).asset!.name).toBe('ชื่อใหม่อีกครั้ง');
  });
  it('an asset that would start depreciating in a month already run is refused (the exit: cancel the runs back to it)', () => {
    blank();
    register(capexBill(), { startDate: '2026-07-01' });
    runDepreciation(st, CO, '2026-07', ME); runDepreciation(st, CO, '2026-08', ME);
    expect(err(() => register(capexBill(), { startDate: '2026-08-15' })).code).toBe('fa.dp_exists');
    expect(register(capexBill(), { startDate: '2026-09-01' }).asset!.depFrom).toBe('2026-09'); // later months are fine
  });
  it('moving an asset (no rows of its own yet) back into a month already run is refused too', () => {
    blank();
    register(capexBill(), { startDate: '2026-07-01' });
    runDepreciation(st, CO, '2026-07', ME); runDepreciation(st, CO, '2026-08', ME);
    const later = register(capexBill(), { startDate: '2026-09-01' }); // nothing of its own depreciated yet
    expect(err(() => reviseAsset(st, CO, later.id, { startDate: '2026-08-10' }, ME)).code).toBe('fa.dp_exists');
    expect(reviseAsset(st, CO, later.id, { startDate: '2026-09-20' }, ME).asset!.depFrom).toBe('2026-09');
    expect(checkInvariants(st)).toEqual([]);
  });
  it('the fixed-asset accounts name the register and the runs as their way in', () => {
    const jl = (id: string, accountCode: string, debit: string, credit: string): DocLine => ({ id, description: 'x', qty: '1', unit: '', unitPrice: '0.00', taxCode: 'EX', accountCode, debit, credit });
    const d = createDraft(st, CO, 'JV', { header: { documentDate: '2026-10-01' }, lines: [jl('j1', '1211', '100.00', '0.00'), jl('j2', '5110', '0.00', '100.00')] }, ME, 'kjv2');
    const e = err(() => issue(st, d.id, d.version, ME));
    expect(e.code).toBe('ledger.control_account');
    expect(e.title).toContain('/accounting/fixed-assets'); expect(e.title).toContain('/accounting/depreciation-runs');
  });
});

describe('fa.before_source: an asset is not in service before its bill', () => {
  it('registering or editing a bill asset with a start date before the bill is refused', () => {
    blank();
    const b = capexBill('12000.00', '2026-08-10');
    expect(err(() => register(b, { startDate: '2026-08-09' })).code).toBe('fa.before_source');
    const fa = register(b, { startDate: '2026-08-10' });
    expect(err(() => reviseAsset(st, CO, fa.id, { startDate: '2026-08-01' }, ME)).code).toBe('fa.before_source');
    expect(checkInvariants(st)).toEqual([]);
  });
});

describe('the seed (fixtures)', () => {
  it('has the assets, runs and the disposal the plan names, and the invariants hold', () => {
    const s = buildSeedState(), d = (id: string) => s.docs.find((x) => x.id === id)!;
    expect(checkInvariants(s)).toEqual([]);
    expect(d('fa-nb').asset).toMatchObject({ startDate: '2026-10-09', accumulated: '0.00', cost: '32000.00' }); // dated its bill's day: October is not due yet
    expect(d('fa-sold').asset!.disposed).toMatchObject({ date: '2026-09-20', kind: 'sale', outcome: 'loss', gainLoss: '1333.33' });
    expect(d('fa-scan').asset!.accumulated).not.toBe('0.00'); // an asset with live rows, and the one September depreciates
    expect(liveDps(s, 'co-vat').map((x) => x.dp!.month)).toEqual(['2026-07', '2026-08']);
    expect(liveDps(s, 'co-nonvat')).toHaveLength(8);
    expect(planDepreciation(s, 'co-vat', '2026-09').problem).toBeUndefined();
    expect(planDepreciation(s, 'co-vat', '2026-09').rows.map((r) => r.assetId)).toEqual(['fa-scan']);
    expect(planDepreciation(s, 'co-vat', '2026-10').problem?.code).toBe('dp.out_of_order');
    runDepreciation(s, 'co-vat', '2026-09', ME);
    expect(planDepreciation(s, 'co-vat', '2026-10').problem?.code).toBe('dp.not_due'); // October has not ended
    expect(checkInvariants(s)).toEqual([]);
  });
});

describe('the locks an asset and a run read with (ruling 2 / 3: "locked, exit: ...")', () => {
  const lockOf = (id: string) => derivedLocks(st, doc(id)).find((l) => l.kind === 'asset');
  it('an asset with run rows or a disposal, and a run that is not the latest, say why and where the way out is', () => {
    blank();
    const a = register(capexBill('36000.00'), { startDate: '2026-08-01' });
    expect(lockOf(a.id)).toBeUndefined(); // nothing stands on it yet
    const aug = runDepreciation(st, CO, '2026-08', ME), sep = runDepreciation(st, CO, '2026-09', ME);
    expect(lockOf(sep.id)).toBeUndefined(); // the latest run is free
    expect(lockOf(aug.id)).toMatchObject({ exits: [expect.stringContaining('ก.ย. 2569')], href: `/accounting/depreciation-runs/${sep.id}` });
    expect(lockOf(a.id)).toMatchObject({ reason: expect.stringContaining('2 งวด'), href: `/accounting/depreciation-runs/${sep.id}` });
    cancel(st, sep.id, doc(sep.id).version, 'OTHER', 'x', ME);
    const off = disposeAsset(st, CO, a.id, { date: '2026-09-10', kind: 'write_off' }, ME);
    expect(lockOf(off.id)).toMatchObject({ reason: expect.stringContaining('จำหน่ายแล้ว') });
    expect(err(() => cancel(st, off.id, doc(off.id).version, 'OTHER', 'x', ME)).code).toBe('fa.has_disposal');
  });
});

// ---------------------------------------------------------------- AC5 fix round 1 (Opus Tier-2): A1 / A2 / A3 / N1, on the seed
describe('AC5 fix1: a disposal stands on the runs and on its own invoice', () => {
  beforeEach(() => { st = buildSeedState(); });
  const tiOf = () => doc(doc('fa-sold').asset!.disposed!.tiId!);
  const noDisposal = (ti: ReturnType<typeof tiOf>) => { const { disposal: _d, ...h } = ti.header; void _d; return h; };

  it('A1: recomputing the latest run is refused while a later disposal stands on it (sale and write-off); the exit is to undo the disposal', () => {
    expect(err(() => reviseDp(st, 'dp-2026-08', ME)).code).toBe('dp.has_disposal');
    expect(checkInvariants(st)).toEqual([]);
    cancel(st, tiOf().id, tiOf().version, 'OTHER', 'x', ME); // the exit
    runDepreciation(st, CO, '2026-09', ME);
    disposeAsset(st, CO, 'fa-scan', { date: '2026-10-10', kind: 'write_off' }, ME);
    const sep = liveDps(st, CO).at(-1)!;
    expect(err(() => reviseDp(st, sep.id, ME)).code).toBe('dp.has_disposal');
    expect(checkInvariants(st)).toEqual([]);
    reverseDisposal(st, CO, 'fa-scan', ME);
    expect(reviseDp(st, sep.id, ME).dp!.month).toBe('2026-09'); // free again
    expect(checkInvariants(st)).toEqual([]);
  });

  it('A2: the disposal invoice takes no revise and no correction plan of any kind (notes only included); nothing moves', () => {
    const ti = tiOf(), before = JSON.stringify(st.docs.find((d) => d.id === ti.id));
    const prop = { header: { ...noDisposal(ti), notes: 'แก้หมายเหตุ' }, lines: ti.lines };
    expect(err(() => correctionPlan(st, ti.id, prop, 'accountant')).code).toBe('fa.disposal_locked'); // non-fiscal branch
    expect(err(() => correctionPlan(st, ti.id, { ...prop, lines: [{ ...ti.lines[0], unitPrice: '20000.00' }] }, 'accountant')).code).toBe('fa.disposal_locked'); // fiscal branch
    expect(err(() => revise(st, ti.id, { header: { ...ti.header, notes: 'x' }, lines: ti.lines }, ti.version, 'x', ME)).code).toBe('fa.disposal_locked'); // the engine backstop
    expect(JSON.stringify(doc(ti.id))).toBe(before);
    expect(checkInvariants(st)).toEqual([]);
  });

  it('N1: header.disposal of a live disposal invoice is the asset\'s frozen disposal (single-fault tamper fires; the ids may differ)', () => {
    expect(checkInvariants(st)).toEqual([]);
    tiOf().header.disposal!.cost = '1.00';
    expect(checkInvariants(st).some((m) => /header\.disposal/.test(m))).toBe(true);
  });
});

describe('AC5 fix1 A3: an opening balance with asset rows is cut off on a month end', () => {
  beforeEach(() => { st = buildSeedState(); });
  it('refuses a mid-month cut-off (ob.asset_cutoff) and accepts the month end; a batch without asset rows is not asked', () => {
    const ob = doc('nob-1');
    const body = (date: string, assets = ob.opening!.assets) => ({ header: { ...ob.header, documentDate: date }, lines: ob.lines, opening: { ...ob.opening!, assets } });
    expect(ob.opening!.assets.length).toBeGreaterThan(0);
    expect(ob.header.documentDate).toBe('2025-12-31'); // the seed complies
    expect(obProblem(st, 'co-nonvat', body('2025-12-15'), ob.id)?.code).toBe('ob.asset_cutoff');
    expect(obProblem(st, 'co-nonvat', body('2025-12-31'), ob.id)?.code).not.toBe('ob.asset_cutoff');
    expect(obProblem(st, 'co-nonvat', body('2025-12-15', []), ob.id)?.code).not.toBe('ob.asset_cutoff');
  });
});
