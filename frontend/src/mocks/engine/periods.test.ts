import { beforeEach, describe, expect, it } from 'vitest';
import { withFixedClock } from './log';
import { revise } from './commands';
import { fixtureIds } from '../fixtures/ids';
import { seed } from '../store';
import { assertBalanced, type Actor, type DocLine, type MockStateLike } from './test-helpers';
import { buildPlan, correctionPlan, executePlan } from './corrections';
import { cancel, createDraft, issue } from './commands';
import { derivedLocks } from './locks';
import { checkInvariants } from './invariants';
import { firstOpenDate, isClosed, periodLock } from './periods';

const me: Actor = { kind: 'user', id: 'u-1', name: 'สมศรี บัญชีดี' };
const line = (p: Partial<DocLine> = {}): DocLine => ({ id: 'l1', description: 'ออกแบบ', qty: '1', unit: 'งาน', unitPrice: '1000.00', taxCode: 'S7', ...p });
/** Σ (debit - credit) per account over every entry dated on/before `cutoff`: what a closed month's books say. */
const glUpTo = (s: MockStateLike, cutoff: string) => {
  const m: Record<string, number> = {};
  for (const j of s.journals) for (const e of j.preview.entries) if (e.date <= cutoff) for (const l of e.lines) m[l.accountCode] = (m[l.accountCode] ?? 0) + Number(l.debit.replace('.', '')) - Number(l.credit.replace('.', ''));
  return m;
};
let st: MockStateLike;
let co: string;
let customer: string;

beforeEach(() => {
  st = seed();
  co = 'co-vat';
  customer = st.parties.find((p) => p.companyId === co && p.kind === 'customer' && p.vatRegistered && p.taxId)!.id;
});
const draftOn = (date: string, key: string) => createDraft(st, co, 'TI', { header: { partyId: customer, documentDate: date }, lines: [line()] }, me, key);

describe('periods (D-10)', () => {
  it('months ≤ 2026-06 are closed in the seed for both companies; 2026-07 onward open', () => {
    for (const c of ['co-vat', 'co-nonvat']) {
      const ps = st.periods.filter((p) => p.companyId === c);
      expect(ps).toHaveLength(24);
      expect(ps.filter((p) => p.status === 'closed').map((p) => p.month)).toEqual(
        [...Array(12).keys()].map((i) => `2025-${String(i + 1).padStart(2, '0')}`).concat(['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06']));
      expect(ps.filter((p) => p.status === 'open').map((p) => p.month)).toEqual(['2026-07', '2026-08', '2026-09', '2026-10', '2026-11', '2026-12']);
      expect(isClosed(st, c, '2026-06-30')).toBe(true);
      expect(isClosed(st, c, '2026-07-01')).toBe(false);
    }
    expect(firstOpenDate(st, co)).toBe('2026-10-01');
  });
  it('firstOpenDate follows a closed current month', () => {
    st.periods.find((p) => p.companyId === co && p.month === '2026-10')!.status = 'closed';
    expect(firstOpenDate(st, co)).toBe('2026-11-01');
  });
  it('issue of a draft dated in a closed month → 422 period.closed with an exit message naming the month', () => {
    const d = draftOn('2026-03-10', 'p1');
    expect(() => issue(st, d.id, d.version, me)).toThrow(/period\.closed/);
    expect(() => issue(st, d.id, d.version, me)).toThrow(/มี\.ค\. 2569/);
    expect(() => issue(st, d.id, d.version, me)).toThrow(/2026-10-01/); // the exit: the first open date
    expect(st.docs.find((x) => x.id === d.id)!.status).toBe('draft');
  });
  it('issue of a draft dated after today → 422 doc.future_date', () => {
    const d = draftOn('2026-10-15', 'p2');
    expect(() => issue(st, d.id, d.version, me)).toThrow(/doc\.future_date/);
    const ok = draftOn('2026-10-14', 'p3');
    expect(issue(st, ok.id, ok.version, me).status).toBe('issued');
  });
  it('a TI dated in a closed month reads with a period lock whose exits are "แก้ไขย้อนหลัง" and reopen', () => {
    const doc = st.docs.find((d) => d.id === fixtureIds(st).tiPeriodLocked)!;
    const lock = derivedLocks(st, doc).find((l) => l.kind === 'period')!;
    expect(lock).toBeDefined();
    expect(lock.exits.some((e) => e.includes('แก้ไขย้อนหลัง'))).toBe(true);
    expect(lock.exits.some((e) => e.includes('เปิดงวด'))).toBe(true);
    expect(doc.locks.some((l) => l.kind === 'period')).toBe(false); // derived at read time, never stored
    expect(periodLock(st, co, '2026-10-05')).toBeUndefined();
    expect(derivedLocks(st, st.docs.find((d) => d.id === fixtureIds(st).tiIssuedUnpaid)!)).toEqual([]);
    expect(derivedLocks(st, st.docs.find((d) => d.status === 'draft')!)).toEqual([]); // drafts carry no lock
  });
  it('M2: correcting a period-locked TI (non-fiscal) revises; a fiscal change reissues — the lock never blocks', () => {
    const ti = st.docs.find((d) => d.id === fixtureIds(st).tiPeriodLocked)!;
    const revise = buildPlan(st, ti.id, { header: { ...ti.header, notes: 'หมายเหตุใหม่' }, lines: ti.lines }, 'accountant');
    expect(revise.steps.map((s) => s.action)).toEqual(['revise']);
    const other = st.parties.find((p) => p.companyId === co && p.kind === 'customer' && p.id !== ti.header.partyId && p.vatRegistered && p.taxId)!;
    const proposed = { header: { ...ti.header, partyId: other.id }, lines: ti.lines };
    const plan = buildPlan(st, ti.id, proposed, 'accountant');
    expect(plan.steps.map((s) => s.action)).toContain('reissue');
    expect(plan.explanation).not.toMatch(/ทำไม่ได้/);
    const closedBooks = glUpTo(st, '2026-06-30');
    const p = correctionPlan(st, ti.id, proposed, 'accountant');
    const res = executePlan(st, p.planId, p.planHash, me);
    const old = st.docs.find((d) => d.id === ti.id)!;
    const entries = st.journals.find((j) => j.docId === ti.id)!.preview.entries;
    expect(entries.map((e) => e.kind)).toEqual(['original', 'reversal']);
    expect(entries[1]).toMatchObject({ date: firstOpenDate(st, co), late: true });
    const created = st.docs.find((d) => d.id === old.replacedById)!;
    expect(res.affected.map((a) => a.docId)).toContain(created.id);
    const ne = st.journals.find((j) => j.docId === created.id)!.preview.entries[0];
    expect(ne).toMatchObject({ kind: 'original', date: firstOpenDate(st, co), late: true }); // D-10: the new entry posts in the first open period too
    expect(created.header.documentDate).toBe(ti.header.documentDate); // I9: the DOCUMENT date is unchanged
    expect(created.outstanding).toBe(created.totals.total);
    expect(glUpTo(st, '2026-06-30')).toEqual(closedBooks); // closed months' books did not move
    assertBalanced(st);
    expect(checkInvariants(st)).toEqual([]);
  });
  it('cancelling a period-locked TI posts the reversal in the first open period, labelled late', () => {
    const ti = st.docs.find((d) => d.id === fixtureIds(st).tiPeriodLocked)!;
    cancel(st, ti.id, ti.version, 'WRONG_PARTY', 'ออกผิดราย', me);
    const e = st.journals.find((j) => j.docId === ti.id)!.preview.entries;
    expect(e[1]).toMatchObject({ kind: 'reversal', date: '2026-10-01', late: true });
    expect(e[0].late).toBeUndefined();
    expect(checkInvariants(st)).toEqual([]);
  });
  it('cancelling a TI in an open period still reverses on today, not late', () => {
    const d = draftOn('2026-10-14', 'p4'); const a = issue(st, d.id, d.version, me);
    cancel(st, a.id, a.version, 'OTHER', 'ทดสอบ', me);
    const e = st.journals.find((j) => j.docId === a.id)!.preview.entries[1];
    expect(e.date).toBe('2026-10-14');
    expect(e.late).toBeUndefined();
  });
  it('a paid TI in a closed month: cancel RC, reissue TI, reissue RC all post in the first open period, closed books unchanged', () => {
    const ti = st.docs.find((d) => d.type === 'TI' && d.status === 'settled' && d.header.documentDate < '2026-07-01' && !d.locks.some((l) => l.kind === 'filing')
      && st.links.filter((l) => l.active && l.to === d.id).every((l) => l.kind === 'settles')
      && st.links.some((l) => l.active && l.to === d.id && st.docs.find((x) => x.id === l.from)!.header.documentDate < '2026-07-01'))!; // its receipt is in a closed month too
    const other = st.parties.find((p) => p.companyId === co && p.kind === 'customer' && p.id !== ti.header.partyId && p.vatRegistered && p.taxId)!;
    const rcId = st.links.find((l) => l.active && l.to === ti.id && l.kind === 'settles')!.from;
    const rcDate = st.docs.find((d) => d.id === rcId)!.header.documentDate;
    const before = glUpTo(st, '2026-06-30');
    const p = correctionPlan(st, ti.id, { header: { ...ti.header, partyId: other.id }, lines: ti.lines }, 'accountant');
    expect(p.steps.map((s) => [s.action, s.docType])).toEqual([['cancel', 'RC'], ['reissue', 'TI'], ['reissue', 'RC']]);
    executePlan(st, p.planId, p.planHash, me);
    const rc2 = st.docs.find((d) => d.replacesId === rcId)!;
    expect(rc2.header.documentDate).toBe(rcDate); // document date kept
    const rcEntry = st.journals.find((j) => j.docId === rc2.id)!.preview.entries[0];
    expect(rcEntry).toMatchObject({ kind: 'original', date: firstOpenDate(st, co), late: true });
    const ti2 = st.docs.find((d) => d.id === st.docs.find((x) => x.id === ti.id)!.replacedById)!;
    expect(st.journals.find((j) => j.docId === ti2.id)!.preview.entries[0]).toMatchObject({ date: firstOpenDate(st, co), late: true });
    expect(glUpTo(st, '2026-06-30')).toEqual(before);
    assertBalanced(st); // includes checkInvariants: outstanding per 7.11, subledger = GL
  });
  it('L-class revise in a closed month: reversal and correction entry both post on the first open date, late', () => {
    const nv = 'co-nonvat';
    const party = st.parties.find((p) => p.companyId === nv && p.kind === 'customer')!.id;
    const d = withFixedClock('2025-06-10T10:00:00+07:00', () => {
      const dr = createDraft(st, nv, 'IV', { header: { partyId: party, documentDate: '2025-06-10' }, lines: [line()] }, me, 'iv1');
      return issue(st, dr.id, dr.version, me);
    });
    expect(d.status).toBe('issued');
    revise(st, d.id, { header: d.header, lines: [line({ unitPrice: '1500.00' })] }, d.version, 'แก้ราคา', me);
    const es = st.journals.find((j) => j.docId === d.id)!.preview.entries;
    expect(es.map((e) => [e.kind, e.date, e.late ?? false])).toEqual([['original', '2025-06-10', false], ['reversal', '2026-10-01', true], ['correction', '2026-10-01', true]]);
    assertBalanced(st);
  });
  it('issue under a pinned clock still refuses a future date', () => {
    const dr = draftOn('2026-10-15', 'p9');
    expect(() => withFixedClock('2026-10-14T10:00:00+07:00', () => issue(st, dr.id, dr.version, me))).toThrow(/doc\.future_date/);
  });
});
