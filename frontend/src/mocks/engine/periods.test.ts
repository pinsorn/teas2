import { beforeEach, describe, expect, it } from 'vitest';
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
    const p = correctionPlan(st, ti.id, proposed, 'accountant');
    const res = executePlan(st, p.planId, p.planHash, me);
    const old = st.docs.find((d) => d.id === ti.id)!;
    const entries = st.journals.find((j) => j.docId === ti.id)!.preview.entries;
    expect(entries.map((e) => e.kind)).toEqual(['original', 'reversal']);
    expect(entries[1]).toMatchObject({ date: firstOpenDate(st, co), late: true });
    const created = st.docs.find((d) => d.id === old.replacedById)!;
    expect(res.affected.map((a) => a.docId)).toContain(created.id);
    const ne = st.journals.find((j) => j.docId === created.id)!.preview.entries[0];
    expect(ne.date).toBe(ti.header.documentDate); // I9: the replacement keeps the original date
    expect(created.header.documentDate).toBe(ti.header.documentDate);
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
});
