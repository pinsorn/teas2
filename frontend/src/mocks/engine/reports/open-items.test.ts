import { beforeEach, describe, expect, it } from 'vitest';
import type { ReportModel } from '@/domain/reports';
import type { Actor, Doc, DocLine, JournalEntryPreview } from '@/domain/types';
import { buildSeedState, type MockState } from '../../store';
import { cancel, createDraft, issue, revise } from '../commands';
import { checkInvariants } from '../invariants';
import { companyEntries } from '../ledger';
import { today } from '../log';
import { toSatang } from '../money';
import { postSettlement, reverseSettlement, unappliedOf } from '../settlement-records';
import { apAging } from './ap-aging';
import { arAging } from './ar-aging';
import { controlByItem, revisionInForce } from './as-of';
import { customerStatement } from './customer-statement';

const ME: Actor = { kind: 'user', id: 'u-1', name: 'สมศรี บัญชีดี' };
const VAT = 'co-vat', NV = 'co-nonvat';
let st: MockState;
beforeEach(() => { localStorage.clear(); st = buildSeedState(); });

const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const items = (m: ReportModel) => m.rows.filter((r) => r.kind === 'row');
const noDiff = (m: ReportModel, label = '') => {
  expect(m.tieOuts!.map((t) => [t.labelKey, t.diff]).filter(([, d]) => d !== '0.00'), `tie-outs ${label}`).toEqual([]);
  expect(m.rows.filter((r) => (r.cells.diff && r.cells.diff !== '0.00') || (r.cells.depDiff && r.cells.depDiff !== '0.00')).map((r) => [r.cells.party, r.cells.diff, r.cells.depDiff]), `rows ${label}`).toEqual([]);
};
const L1 = (price: string, taxCode: DocLine['taxCode'] = 'EX'): DocLine[] => [{ id: 'l1', description: 'x', qty: '1', unit: 'งาน', unitPrice: price, taxCode }];
const doc = (id: string) => st.docs.find((d) => d.id === id)!;
/** The seeded live invoices / bills of a company that nothing has touched (no link), so their journal and stored balance are exactly the document. */
const untouched = (co: string, type: string) => st.docs.filter((d) => d.companyId === co && d.type === type && d.status === 'issued' && !!d.header.partyId && !st.links.some((l) => l.to === d.id || l.from === d.id));
const lineOf = (docId: string, code: string, n = 0) => st.journals.find((j) => j.docId === docId)!.preview.entries[0].lines.filter((l) => l.accountCode === code)[n];
const tie = (m: ReportModel, key: string) => m.tieOuts!.find((t) => t.labelKey === `reports.arap.${key}`)!;
/** Exactly this set of findings: each fragment names one finding and there is nothing else. */
const only = (frags: string[]) => {
  const found = checkInvariants(st);
  expect(found.length, JSON.stringify(found)).toBe(frags.length);
  for (const f of frags) expect(found.filter((x) => x.includes(f)).length, `${f} in ${JSON.stringify(found)}`).toBeGreaterThanOrEqual(1);
  return found;
};

describe('RP2a invariants 23 + 24: the seed is clean and each single fault is named exactly', () => {
  it('the seed has no finding', () => { expect(checkInvariants(st)).toEqual([]); });

  it('F1: an invoice whose AR line lost its tag -> no open item + its journal is 0, its row is gone and the orphan shows on its own tie line', () => {
    const ti = untouched(VAT, 'TI')[0], amount = ti.totals.total;
    delete lineOf(ti.id, '1130').openItemId;
    only(['has no open item', `${ti.id}: open item journal 0 but its stored balance is`]);
    const m = arAging(st, VAT, { asOf: today() });
    expect(items(m).find((r) => r.cells.party === ti.number)).toBeUndefined();
    expect(tie(m, 'arTieNoItem')).toMatchObject({ left: amount, diff: amount });
    expect(m.rows.find((r) => r.kind === 'group' && r.cells.party.startsWith(st.parties.find((p) => p.id === ti.header.partyId)!.code))!.cells.diff).toBe(`-${amount}`);
  });

  it('F2: retagged to another customer\'s invoice -> wrong party + both invoices off; the two parties differ with opposite signs, no orphan', () => {
    const [a, b] = untouched(VAT, 'TI').filter((d, i, all) => all.findIndex((x) => x.header.partyId === d.header.partyId) === i);
    expect(a.header.partyId).not.toBe(b.header.partyId);
    lineOf(a.id, '1130').openItemId = b.id;
    only(['of party', `${a.id}: open item journal`, `${b.id}: open item journal`]);
    const m = arAging(st, VAT, { asOf: today() });
    const diffOf = (id: string) => toSatang(m.rows.find((r) => r.kind === 'group' && r.cells.party.startsWith(st.parties.find((p) => p.id === id)!.code))!.cells.diff);
    expect(diffOf(a.header.partyId!)).toBe(-toSatang(a.totals.total));
    expect(diffOf(b.header.partyId!)).toBe(toSatang(a.totals.total));
    expect(tie(m, 'arTieNoItem').diff).toBe('0.00');
  });

  it('F3: retagged to an id that is no document', () => {
    const ti = untouched(VAT, 'TI')[0];
    lineOf(ti.id, '1130').openItemId = 'doc-nope';
    only(['names doc-nope', `${ti.id}: open item journal 0`]);
    expect(tie(arAging(st, VAT, { asOf: today() }), 'arTieNoItem').diff).toBe(ti.totals.total);
  });

  it('F4: a bill\'s AP line tagged with an invoice id -> wrong type + the bill is off; the orphan shows on the AP side', () => {
    const pb = untouched(VAT, 'PB')[0], ti = untouched(VAT, 'TI')[0];
    lineOf(pb.id, '2110').openItemId = ti.id;
    only(['names ' + ti.id, `${pb.id}: open item journal 0`]);
    expect(tie(apAging(st, VAT, { asOf: today() }), 'apTieNoItem').diff).toBe(pb.totals.total);
  });

  it('F5: a receipt\'s deposit line without its tag', () => {
    const rc = doc(st.docs.find((d) => d.number === 'RC-202610-0005')!.id);
    delete lineOf(rc.id, '2140').openItemId;
    only(['has no open item', `${rc.id}: open item journal 0`]);
    expect(tie(arAging(st, VAT, { asOf: today() }), 'arTieDepNoItem')).toMatchObject({ left: '-5000.00', diff: '-5000.00' });
  });

  it('F6: one per-item AR line of the opening batch without its tag -> + the batch journal is not what its steps say; the item\'s row is gone', () => {
    const batch = doc('nob-1'), item = batch.opening!.openItems.find((i) => i.side === 'AR')!;
    const l = st.journals.find((j) => j.docId === batch.id)!.preview.entries[0].lines.find((x) => x.openItemId === item.id)!;
    delete l.openItemId;
    only(['has no open item', `${item.id}: open item journal 0`, 'OB journal is not what its steps say']);
    const m = arAging(st, NV, { asOf: today() });
    expect(items(m).some((r) => r.cells.party === `${item.docNumber} (ยกมา)`)).toBe(false);
    expect(tie(m, 'arTieNoItem').diff).toBe(item.amount);
  });
});

describe('RP2a T7: revisionInForce on hand-built journals', () => {
  const snap = (revision: number, dueDate: string) => ({ docId: 'd', revision, at: '', actor: ME, snapshot: { id: 'd', header: { documentDate: '2026-10-01', dueDate }, revision } as unknown as Doc, diff: [] });
  const world = (entries: Partial<JournalEntryPreview>[], revs: number[] = [], docs = true): MockState =>
    ({ journals: [{ docId: 'd', preview: { entries: entries.map((e) => ({ lines: [], ...e })) } }], revisions: revs.map((r) => snap(r, `due-${r}`)), docs: docs ? [{ id: 'd', header: { dueDate: 'due-now' } }] : [] }) as unknown as MockState;
  const due = (s: MockState, asOf: string) => revisionInForce(s, 'd', asOf)?.header.dueDate;
  it('moved later in an open month: [o 10-08, r 10-08, c 10-11]', () => {
    const s = world([{ kind: 'original', date: '2026-10-08', revision: 0 }, { kind: 'reversal', date: '2026-10-08' }, { kind: 'correction', date: '2026-10-11', revision: 1 }], [0, 1]);
    expect(due(s, '2026-10-07')).toBeUndefined();
    expect(due(s, '2026-10-09')).toBeUndefined(); // the original is reversed, the correction is not yet there
    expect(due(s, '2026-10-11')).toBe('due-1');
  });
  it('moved earlier: [o 10-11, r 10-11, c 10-08]', () => {
    const s = world([{ kind: 'original', date: '2026-10-11', revision: 0 }, { kind: 'reversal', date: '2026-10-11' }, { kind: 'correction', date: '2026-10-08', revision: 1 }], [0, 1]);
    expect(due(s, '2026-10-07')).toBeUndefined();
    expect(due(s, '2026-10-09')).toBe('due-1');
    expect(due(s, '2026-10-12')).toBe('due-1');
  });
  it('closed month, revised late: [o 09-20, r 10-01, c 10-01] -> the original until the late correction', () => {
    const s = world([{ kind: 'original', date: '2026-09-20', revision: 0 }, { kind: 'reversal', date: '2026-10-01', late: true }, { kind: 'correction', date: '2026-10-01', revision: 1, late: true }], [0, 1]);
    expect(due(s, '2026-09-25')).toBe('due-0');
    expect(due(s, '2026-09-30')).toBe('due-0');
    expect(due(s, '2026-10-01')).toBe('due-1');
  });
  it('cancelled: [o, r] is in force from the original until the day before the reversal', () => {
    const s = world([{ kind: 'original', date: '2026-10-02', revision: 0 }, { kind: 'reversal', date: '2026-10-09' }], [0]);
    expect(due(s, '2026-10-01')).toBeUndefined();
    expect(due(s, '2026-10-02')).toBe('due-0');
    expect(due(s, '2026-10-08')).toBe('due-0');
    expect(due(s, '2026-10-09')).toBeUndefined();
  });
  it('edited in place (T-class, no repost): [o] revision 0 and a snapshot of revision 1 -> the latest', () => {
    expect(due(world([{ kind: 'original', date: '2026-10-02', revision: 0 }], [0, 1]), '2026-10-03')).toBe('due-1');
  });
  it('no revision rows (a document entered directly) -> the document as stored; no entry on or before the date -> none', () => {
    const s = world([{ kind: 'original', date: '2026-10-02' }]);
    expect(due(s, '2026-10-02')).toBe('due-now');
    expect(due(s, '2026-10-01')).toBeUndefined();
  });
});

describe('RP2a T8 (T-INV-C): every posted entry of a document names its revision', () => {
  const DOCS = ['TI', 'IV', 'DN', 'CN', 'PB', 'PDN', 'PCN', 'RC', 'PV', 'OB'];
  const structural = (label: string) => {
    for (const j of st.journals) {
      const d = st.docs.find((x) => x.id === j.docId);
      if (!d || !DOCS.includes(d.type) || d.header.obBatchId) continue;
      const posted = j.preview.entries.filter((e) => e.kind !== 'reversal');
      expect(posted.every((e) => typeof e.revision === 'number'), `${label} ${d.id} entries carry a revision`).toBe(true);
      expect(j.preview.entries.filter((e) => e.kind === 'reversal').every((e) => e.revision === undefined), `${label} ${d.id} a reversal carries none`).toBe(true);
      if (d.type !== 'RC') posted.forEach((e, k) => { if (e.kind === 'correction') expect(e.revision, `${label} ${d.id}`).toBeGreaterThan(posted[k - 1]?.revision ?? -1); });
    }
  };
  it('the seed, and after two L-class revisions the k-th posted entry is revision k', () => {
    structural('seed');
    const iv = st.docs.find((d) => d.companyId === NV && d.number === 'IV-202610-0001')!;
    const r1 = revise(st, iv.id, { header: iv.header, lines: iv.lines.map((l, i) => (i === 0 ? { ...l, unitPrice: String(Number(l.unitPrice) + 10) } : l)) }, iv.version, 'x', ME);
    revise(st, iv.id, { header: r1.header, lines: r1.lines.map((l, i) => (i === 0 ? { ...l, unitPrice: String(Number(l.unitPrice) + 10) } : l)) }, r1.version, 'x', ME);
    expect(st.journals.find((j) => j.docId === iv.id)!.preview.entries.filter((e) => e.kind !== 'reversal').map((e) => e.revision)).toEqual([0, 1, 2]);
    structural('revised');
    expect(checkInvariants(st)).toEqual([]);
  });
});

describe('RP2a T1b: a credit note revised in place', () => {
  it('the bill reads the old note amount before the revise date and the new one from it, and the books tie on every date', () => {
    const d = createDraft(st, VAT, 'PB', { header: { partyId: 'pv-01', documentDate: '2026-10-02', vendorDocNumber: 'T1B', vendorDocDate: '2026-10-02' }, lines: L1('1000', 'S7') }, ME, 'k-t1b');
    const pb = issue(st, d.id, d.version, ME);
    const nd = createDraft(st, VAT, 'PCN', { header: { documentDate: '2026-10-06', refDocId: pb.id, reasonCode: 'DISCOUNT', vendorDocNumber: 'T1B-N', vendorDocDate: '2026-10-06' }, lines: [{ ...L1('200', 'S7')[0], id: 'n1', sourceLineId: 'l1' }] }, ME, 'k-t1b-n');
    const pcn = issue(st, nd.id, nd.version, ME);
    const at = (d2: string) => items(apAging(st, VAT, { asOf: d2 })).find((r) => r.cells.party === pb.number)?.cells.total;
    expect(at('2026-10-05')).toBe('1070.00');
    expect(at('2026-10-06')).toBe('856.00'); // 1,070.00 - 214.00
    const r = revise(st, pcn.id, { header: pcn.header, lines: pcn.lines.map((l) => ({ ...l, unitPrice: '300' })) }, pcn.version, 'x', ME);
    expect(toSatang(r.totals.total)).toBeGreaterThan(toSatang(pcn.totals.total));
    expect(at('2026-10-05')).toBe('1070.00');
    expect(toSatang(at('2026-10-06')!)).toBe(107000 - toSatang(r.totals.total)); // the NEW note amount, from the date it was posted (the old one is reversed that day)
    for (const x of ['2026-10-01', '2026-10-05', '2026-10-06', today()]) noDiff(apAging(st, VAT, { asOf: x }), x);
    expect(checkInvariants(st)).toEqual([]);
  });
});

describe('RP2a T2 (c) + (d): moved earlier, and an opening batch moved to a later cut-off', () => {
  it('(c) an invoice issued on 10-11 and revised to 10-08 is present from 10-08 with the new date', () => {
    const d = createDraft(st, NV, 'IV', { header: { partyId: 'nc-01', documentDate: '2026-10-11' }, lines: L1('700') }, ME, 'k-t2c');
    const iv = issue(st, d.id, d.version, ME);
    revise(st, iv.id, { header: { ...iv.header, documentDate: '2026-10-08' }, lines: iv.lines }, iv.version, 'x', ME);
    const f = (x: string) => items(arAging(st, NV, { asOf: x })).find((r) => r.cells.party === iv.number)?.cells;
    expect(f('2026-10-07')).toBeUndefined();
    for (const x of ['2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11', today()]) expect(f(x)?.docDate, x).toBe('2026-10-08');
    for (const x of ['2026-10-07', '2026-10-08', '2026-10-10', '2026-10-11', '2026-10-12']) noDiff(arAging(st, NV, { asOf: x }), x);
  });
  it('(d) an opening batch (cut-off 29 Jun) revised to a cut-off one day later: its items keep their ids, are absent on the old cut-off and present from the new one', () => {
    // the seeded batch of the non-VAT company is bound to an asset and a payroll year (fa.source_locked, payroll.ob_in_use): the VAT company has none, so the test issues its own
    const line = (code: string, debit: string, credit: string): DocLine => ({ id: `ol-${code}`, description: 'ยอดยกมา', qty: '1', unit: '', unitPrice: '0.00', taxCode: 'EX', accountCode: code, debit, credit });
    const ar = (partyId: string, amount: string, docNumber: string) => ({ id: `it-${partyId}`, side: 'AR' as const, partyId, docNumber, docDate: '2026-05-01', dueDate: '2026-05-31', amount });
    const d = createDraft(st, VAT, 'OB', { header: { documentDate: '2026-06-29' }, lines: [line('1130', '1500.00', '0.00')], opening: { openItems: [ar('pc-01', '1000.00', 'IV-OLD-1'), ar('pc-02', '500.00', 'IV-OLD-2')], assets: [], payrollYtd: [], bank: [] } }, ME, 'k-t2d');
    const b = issue(st, d.id, d.version, ME), cut = '2026-06-29', next = '2026-06-30', ids = b.opening!.openItems.map((i) => i.id);
    const ob = (x: string) => items(arAging(st, VAT, { asOf: x })).filter((r) => r.cells.party.startsWith('IV-OLD')).length;
    expect([ob(cut), ob(next)]).toEqual([2, 2]);
    revise(st, b.id, { header: { ...b.header, documentDate: next }, lines: b.lines, opening: b.opening }, b.version, 'x', ME);
    expect(doc(b.id).opening!.openItems.map((i) => i.id)).toEqual(ids);
    expect([ob(addDays(cut, -1)), ob(cut), ob(next)]).toEqual([0, 0, 2]);
    expect(items(arAging(st, VAT, { asOf: next })).find((r) => r.cells.party === 'IV-OLD-1 (ยกมา)')?.cells.docDate).toBe('2026-05-01');
    for (const x of [addDays(cut, -1), cut, next, addDays(next, 1), today()]) noDiff(arAging(st, VAT, { asOf: x }), x);
    const dates = new Set<string>(['2025-01-01', today()]); // T4: every entry date and the day before, both sides
    for (const e of companyEntries(st, VAT)) { dates.add(e.date); dates.add(addDays(e.date, -1)); }
    for (const x of dates) { noDiff(arAging(st, VAT, { asOf: x }), `AR ${x}`); noDiff(apAging(st, VAT, { asOf: x }), `AP ${x}`); }
    expect(checkInvariants(st)).toEqual([]);
  });
});

describe('RP2a T3 (b) + (c): closed month', () => {
  const closeThrough = (co: string, month: string) => { for (const p of st.periods.filter((x) => x.companyId === co && x.month <= month)) { p.status = 'closed'; (p as { closedAt?: string }).closedAt = '2099-01-01T00:00:00Z'; } };
  it('(b) a voucher of a closed month revised down: the bill reads the old allocation until the first open date', () => {
    const d = createDraft(st, NV, 'PB', { header: { partyId: 'nv-01', documentDate: '2026-09-02', vendorDocNumber: 'T3B', vendorDocDate: '2026-09-02' }, lines: L1('1000') }, ME, 'k-t3b');
    const pb = issue(st, d.id, d.version, ME);
    const pvd = createDraft(st, NV, 'PV', { header: { partyId: 'nv-01', documentDate: '2026-09-06', bankAccountId: st.bankAccounts.find((x) => x.companyId === NV)!.id }, lines: [], allocations: [{ targetId: pb.id, targetType: 'PB', amount: '500.00' }] }, ME, 'k-t3b-pv');
    const pv = issue(st, pvd.id, pvd.version, ME);
    closeThrough(NV, '2026-09');
    revise(st, pv.id, { header: pv.header, lines: [], allocations: [{ targetId: pb.id, targetType: 'PB', amount: '300.00' }] }, pv.version, 'x', ME);
    const at = (x: string) => items(apAging(st, NV, { asOf: x })).find((r) => r.cells.party === pb.number)?.cells.total;
    expect([at('2026-09-05'), at('2026-09-06'), at('2026-09-30'), at('2026-10-01'), at(today())]).toEqual(['1000.00', '500.00', '500.00', '700.00', '700.00']);
    for (const x of ['2026-09-05', '2026-09-06', '2026-09-30', '2026-10-01', today()]) noDiff(apAging(st, NV, { asOf: x }), x);
    expect(checkInvariants(st)).toEqual([]);
  });
  it('(d) a closed-month invoice whose customer is changed: before the late correction it is the old customer, after it the new one, and invariants 23 + 24 hold', () => {
    const d = createDraft(st, NV, 'IV', { header: { partyId: 'nc-01', documentDate: '2026-09-10' }, lines: L1('800') }, ME, 'k-t3d');
    const iv = issue(st, d.id, d.version, ME);
    closeThrough(NV, '2026-09');
    revise(st, iv.id, { header: { ...iv.header, partyId: 'nc-02' }, lines: iv.lines }, iv.version, 'x', ME);
    const owner = (x: string) => { let cur = ''; for (const r of arAging(st, NV, { asOf: x }).rows) { if (r.kind === 'group') cur = r.cells.party; else if (r.cells.party === iv.number) return cur; } return undefined; };
    const code = (id: string) => st.parties.find((p) => p.id === id)!.code;
    expect(owner('2026-09-09')).toBeUndefined();
    expect(owner('2026-09-30')?.startsWith(code('nc-01'))).toBe(true);
    expect(owner('2026-10-01')?.startsWith(code('nc-02'))).toBe(true);
    for (const x of ['2026-09-09', '2026-09-10', '2026-09-30', '2026-10-01', today()]) noDiff(arAging(st, NV, { asOf: x }), x);
    expect(checkInvariants(st)).toEqual([]);
  });
  it('(c) a closed-month invoice moved into the open month: refused, or the original date until the late correction', () => {
    const iv = doc(st.docs.find((d) => d.companyId === NV && d.number === 'IV-202609-0004')!.id), orig = iv.header.documentDate;
    closeThrough(NV, '2026-09');
    let moved = true;
    try { revise(st, iv.id, { header: { ...iv.header, documentDate: '2026-10-05' }, lines: iv.lines }, iv.version, 'x', ME); } catch { moved = false; }
    const f = (x: string) => items(arAging(st, NV, { asOf: x })).find((r) => r.cells.party === 'IV-202609-0004')?.cells.docDate;
    if (!moved) { expect(doc(iv.id).header.documentDate).toBe(orig); expect(f('2026-09-30')).toBe(orig); return; } // the engine refuses the move: nothing changed
    expect(f('2026-09-25')).toBe(orig);
    expect(f(today())).toBe('2026-10-05');
    for (const x of ['2026-09-25', '2026-09-30', '2026-10-01', '2026-10-05', today()]) noDiff(arAging(st, NV, { asOf: x }), x);
  });
});

describe('RP2a T5 (T-INV-B): at today the rows equal the STORED balances, independent of the journal', () => {
  const check = (label: string) => {
    for (const co of [VAT, NV]) for (const side of ['AR', 'AP'] as const) {
      const m = (side === 'AR' ? arAging : apAging)(st, co, { asOf: today() });
      for (const r of items(m)) {
        const d = st.docs.find((x) => x.companyId === co && (x.number === r.cells.party || x.id === r.cells.party));
        if (r.cells.total) {
          const ob = d?.type === 'OB';
          expect(d, `${label} ${r.cells.party}`).toBeDefined();
          expect(toSatang(r.cells.total), `${label} ${co} ${side} ${r.cells.party}`).toBe(toSatang(d!.outstanding ?? d!.totals.total));
          void ob;
        } else if (r.cells.deposit) expect(toSatang(r.cells.deposit), `${label} ${r.cells.party}`).toBe(-unappliedOf(st, d!));
      }
    }
  };
  it('the seed and after a revise, a cancel and a settlement', () => {
    check('seed');
    const d = createDraft(st, NV, 'PB', { header: { partyId: 'nv-01', documentDate: '2026-10-02', vendorDocNumber: 'T5', vendorDocDate: '2026-10-02' }, lines: L1('900') }, ME, 'k-t5');
    const pb = issue(st, d.id, d.version, ME);
    const r = revise(st, pb.id, { header: { ...pb.header, documentDate: '2026-10-04' }, lines: L1('950') }, pb.version, 'x', ME);
    check('revised');
    cancel(st, r.id, r.version, 'other', 'ทดสอบ', ME);
    check('cancelled');
  });
});

describe('RP2a T6: a deposit applied by a settlement record and reversed in a closed month', () => {
  it('the deposit column equals 2140 for the party on every date', () => {
    const rd = createDraft(st, VAT, 'RC', { header: { partyId: 'pc-04', documentDate: '2026-09-02', depositAmount: '2000.00' }, lines: [] }, ME, 'k-t6-rc');
    const rc = issue(st, rd.id, rd.version, ME);
    const td = createDraft(st, VAT, 'TI', { header: { partyId: 'pc-04', documentDate: '2026-09-03', dueDate: '2026-10-03' }, lines: L1('1000', 'S7') }, ME, 'k-t6-ti');
    const ti = issue(st, td.id, td.version, ME);
    const s = postSettlement(st, VAT, { kind: 'apply_deposit', date: '2026-09-05', partyId: 'pc-04', sources: [{ docId: rc.id, amount: '1000.00' }], targets: [{ docId: ti.id, amount: '1000.00' }] }, ME);
    for (const x of ['2026-09-04', '2026-09-05', today()]) noDiff(arAging(st, VAT, { asOf: x }), x);
    for (const p of st.periods.filter((x) => x.companyId === VAT && x.month <= '2026-09')) { p.status = 'closed'; (p as { closedAt?: string }).closedAt = '2099-01-01T00:00:00Z'; }
    reverseSettlement(st, VAT, s.id, ME, 'ทดสอบ'); // the reversal posts late, into the first open month
    const dates = new Set<string>(['2026-09-04', '2026-09-05', today()]);
    for (const e of companyEntries(st, VAT)) { dates.add(e.date); dates.add(addDays(e.date, -1)); }
    for (const x of dates) if (x >= '2026-09-02') noDiff(arAging(st, VAT, { asOf: x }), x);
    expect(checkInvariants(st)).toEqual([]);
  });
});

describe('RP2a: the reader', () => {
  it('controlByItem ignores lines after the date and reports lines naming no item under \'\'', () => {
    const ti = untouched(VAT, 'TI')[0];
    const rows = controlByItem(st, VAT, '1130', '9999-12-31'), before = controlByItem(st, VAT, '1130', '2000-01-01');
    expect(rows.find((r) => r.openItemId === ti.id)?.amount).toBe(toSatang(ti.totals.total));
    expect(before).toEqual([]);
    delete lineOf(ti.id, '1130').openItemId;
    expect(controlByItem(st, VAT, '1130', '9999-12-31').find((r) => r.openItemId === '')?.amount).toBe(toSatang(ti.totals.total));
  });
});

describe('RP2a m1: the statement description never prints the posting rule', () => {
  it('no row carries an arrow or a rule text; a receipt row names the invoice it paid', () => {
    const c = st.docs.find((d) => d.number === 'RC-202610-0004')!, ti = st.docs.find((d) => d.number === 'TI-202603-0002')!;
    const m = customerStatement(st, VAT, { party: ti.header.partyId!, from: '2026-01-01', to: today() });
    const body = m.rows.filter((r) => r.kind === 'row');
    expect(body.length).toBeGreaterThan(0);
    for (const r of body) { expect(r.cells.desc).not.toContain('→'); expect(r.cells.desc).not.toMatch(/ลูกหนี้|AR →/); }
    const rcRow = body.find((r) => r.cells.doc.startsWith(c.number!));
    expect(rcRow?.cells.desc).toContain(`อ้างอิง ${ti.number}`);
    expect(m.tieOuts!.map((t) => t.diff)).toEqual(['0.00', '0.00']);
  });
});
