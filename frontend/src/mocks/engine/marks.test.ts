import { beforeEach, describe, expect, it } from 'vitest';
import type { Doc } from '@/domain/types';
import { assertBalanced, type Actor, type DocLine, type MockStateLike } from './test-helpers';
import { seed } from '../store';
import { cancel, convert, createDraft, deleteDraft, issue, revise } from './commands';
import { remainingOf, setMark } from './marks';

const me: Actor = { kind: 'user', id: 'u-1', name: 'สมศรี บัญชีดี' };
const line = (p: Partial<DocLine> = {}): DocLine => ({ id: 'l1', description: 'กระดาษ', qty: '10', unit: 'รีม', unitPrice: '100.00', taxCode: 'S7', ...p });
let st: MockStateLike;
let co: string;
let cust: string;
let n = 0;

beforeEach(() => {
  st = seed();
  co = st.companies.find((c) => c.vatRegistered)!.id;
  cust = st.parties.find((p) => p.companyId === co && p.kind === 'customer' && p.vatRegistered && p.taxId)!.id;
});
const qt = (lines: DocLine[] = [line()]): Doc => {
  const d = createDraft(st, co, 'QT', { header: { partyId: cust, documentDate: '2026-10-14' }, lines }, me, `qt-${++n}`);
  return issue(st, d.id, d.version, me);
};
const get = (id: string) => st.docs.find((d) => d.id === id)!;

describe('S1 seed (fixtures/specs/sales.ts)', () => {
  it('quotations come out of the engine with their marks, a cancel reason, and the invariants hold', () => {
    const by = (id: string) => get(id);
    expect(['qt-d1', 'qt-d2', 'nqt-d1'].map((i) => by(i).status)).toEqual(['draft', 'draft', 'draft']);
    expect(by('qt-acc').marks?.accepted).toBeDefined();
    expect(by('qt-acc').lines).toHaveLength(2);
    expect(by('qt-rej').marks?.rejected?.reason).toBe('ราคาสูงกว่างบประมาณ');
    expect([by('qt-can').status, by('qt-can').cancel?.reasonText]).toEqual(['cancelled', 'ลูกค้ายกเลิกโครงการ']);
    expect(by('nqt-2').marks?.accepted).toBeDefined();
    expect([by('nqt-1').companyId, by('nqt-1').status, by('nqt-1').totals.vat]).toEqual(['co-nonvat', 'issued', '0.00']);
    expect(by('qt-r1').revision).toBe(1);
    assertBalanced(st);
  });
});

describe('marks (S1)', () => {
  it('reject requires a reason; accepted clears rejected and vice versa', () => {
    const q = qt();
    expect(() => setMark(st, q.id, 'rejected', q.version, me)).toThrow(/mark\.reason_required/);
    expect(() => setMark(st, q.id, 'rejected', q.version, me, '   ')).toThrow(/mark\.reason_required/);
    const r = setMark(st, q.id, 'rejected', q.version, me, 'ราคาสูงกว่างบประมาณ');
    expect(r.marks?.rejected).toMatchObject({ reason: 'ราคาสูงกว่างบประมาณ', by: me.name });
    expect(r.marks?.accepted).toBeUndefined();
    const a = setMark(st, q.id, 'accepted', r.version, me);
    expect(a.marks?.accepted).toMatchObject({ by: me.name });
    expect(a.marks?.rejected).toBeUndefined();
    const r2 = setMark(st, q.id, 'rejected', a.version, me, 'เปลี่ยนใจ');
    expect(r2.marks?.accepted).toBeUndefined();
    expect(r2.marks?.rejected?.reason).toBe('เปลี่ยนใจ');
  });
  it('refuses a mark the type does not carry, a stale version and a document that is not live', () => {
    const q = qt();
    expect(() => setMark(st, q.id, 'delivered', q.version, me)).toThrow(/mark\.not_allowed/);
    expect(() => setMark(st, q.id, 'accepted', q.version + 5, me)).toThrow(/doc\.version_conflict/);
    const draft = createDraft(st, co, 'QT', { header: { partyId: cust, documentDate: '2026-10-14' }, lines: [line()] }, me, 'qt-draft');
    expect(() => setMark(st, draft.id, 'accepted', draft.version, me)).toThrow(/doc\.not_live/);
    const c = cancel(st, q.id, q.version, 'OTHER', 'x', me);
    expect(() => setMark(st, q.id, 'accepted', c.version, me)).toThrow(/doc\.not_live/);
  });
  it('converting a rejected QT is refused with qt.rejected; after a revision it converts and is stamped accepted', () => {
    const q = qt();
    const r = setMark(st, q.id, 'rejected', q.version, me, 'แพงไป');
    expect(() => convert(st, q.id, 'SO', [{ sourceLineId: 'l1', qty: '1' }], me)).toThrow(/qt\.rejected.*แก้ไขเป็นฉบับใหม่หรือคัดลอกเป็นใบใหม่/);
    const rev = revise(st, q.id, { header: r.header, lines: r.lines }, r.version, 'ปรับราคา', me);
    expect(rev.revision).toBe(1);
    expect(rev.marks?.rejected).toBeUndefined();
    expect(rev.marks?.accepted).toBeUndefined();
    convert(st, q.id, 'SO', [{ sourceLineId: 'l1', qty: '1' }], me);
    expect(get(q.id).marks?.accepted).toMatchObject({ by: me.name });
    assertBalanced(st);
  });
  it('a conversion keeps an accepted stamp that is already there (at is not rewritten)', () => {
    const q = qt();
    const a = setMark(st, q.id, 'accepted', q.version, me);
    convert(st, q.id, 'SO', [{ sourceLineId: 'l1', qty: '1' }], me);
    expect(get(q.id).marks?.accepted).toEqual(a.marks?.accepted);
  });
  it('the stamp from a conversion leaves the same trail as a manual accept (activity + audit with before/after)', () => {
    const q = qt();
    const acts = st.activity.filter((a) => a.docId === q.id).length;
    convert(st, q.id, 'SO', [{ sourceLineId: 'l1', qty: '1' }], me);
    const log = st.activity.filter((a) => a.docId === q.id).slice(acts);
    const acc = log.find((a) => a.action === 'accept')!;
    expect(acc.detail).toMatch(/แปลง/);
    expect(acc.actor).toEqual(me);
    const aud = st.audit.filter((a) => a.command === 'doc.mark' && a.target === q.id);
    expect(aud).toHaveLength(1);
    expect(aud[0].before).toEqual({ marks: undefined });
    expect((aud[0].after as { marks: { accepted: unknown } }).marks.accepted).toEqual(get(q.id).marks?.accepted);
    convert(st, q.id, 'SO', [{ sourceLineId: 'l1', qty: '1' }], me); // already accepted: no second trail
    expect(st.audit.filter((a) => a.command === 'doc.mark' && a.target === q.id)).toHaveLength(1);
    expect(st.activity.filter((a) => a.docId === q.id && a.action === 'accept')).toHaveLength(1);
  });
  it('the stamp keeps the stored row intact (company, number, lines) and a held stale version is then refused', () => {
    const q = qt();
    const before = get(q.id);
    convert(st, q.id, 'SO', [{ sourceLineId: 'l1', qty: '1' }], me);
    const after = get(q.id);
    expect(after.version).toBe(q.version + 1);
    expect([after.companyId, after.number, after.status, after.lines, after.totals]).toEqual([before.companyId, before.number, before.status, before.lines, before.totals]);
    expect(() => setMark(st, q.id, 'rejected', q.version, me, 'x')).toThrow(/doc.version_conflict/);
    expect(() => cancel(st, q.id, q.version, 'OTHER', 'x', me)).toThrow(/doc.version_conflict/);
  });
  it('quantity comes back when the target draft is deleted or the target is cancelled', () => {
    const q = qt();
    const so = convert(st, q.id, 'SO', [{ sourceLineId: 'l1', qty: '4' }], me);
    expect(remainingOf(st, q.id)[0].remaining).toBe('6');
    deleteDraft(st, so.id, so.version, me);
    expect(remainingOf(st, q.id)[0]).toMatchObject({ converted: '0', remaining: '10' });
    const so2 = convert(st, q.id, 'SO', [{ sourceLineId: 'l1', qty: '10' }], me);
    expect(remainingOf(st, q.id)[0].remaining).toBe('0');
    const issued = issue(st, so2.id, so2.version, me);
    cancel(st, so2.id, issued.version, 'OTHER', 'x', me);
    expect(remainingOf(st, q.id)[0]).toMatchObject({ converted: '0', remaining: '10' });
  });
  it('marks never create a revision and never change totals', () => {
    const q = qt();
    const revs = st.revisions.filter((r) => r.docId === q.id).length;
    const acts = st.activity.filter((a) => a.docId === q.id).length;
    const a = setMark(st, q.id, 'accepted', q.version, me);
    const r = setMark(st, q.id, 'rejected', a.version, me, 'เหตุผล');
    expect(st.revisions.filter((x) => x.docId === q.id)).toHaveLength(revs);
    expect(r.revision).toBe(q.revision);
    expect(r.totals).toEqual(q.totals);
    const log = st.activity.filter((x) => x.docId === q.id);
    expect(log).toHaveLength(acts + 2);
    expect(log.slice(-2).map((x) => [x.action, x.detail])).toEqual([['accept', undefined], ['reject', 'เหตุผล']]);
    expect(st.audit.some((x) => x.command === 'doc.mark' && x.target === q.id)).toBe(true);
  });
  it('a QT → SO conversion of 3 of 10 units leaves 7 remaining; a second conversion of 8 is refused (doc.over_conversion)', () => {
    const q = qt();
    expect(remainingOf(st, q.id)).toEqual([{ lineId: 'l1', description: 'กระดาษ', unit: 'รีม', ordered: '10', converted: '0', remaining: '10', closed: false }]);
    convert(st, q.id, 'SO', [{ sourceLineId: 'l1', qty: '3' }], me);
    expect(remainingOf(st, q.id)[0]).toMatchObject({ converted: '3', remaining: '7' });
    expect(() => convert(st, q.id, 'SO', [{ sourceLineId: 'l1', qty: '8' }], me)).toThrow(/doc\.over_conversion/);
    convert(st, q.id, 'SO', [{ sourceLineId: 'l1', qty: '7' }], me);
    expect(remainingOf(st, q.id)[0]).toMatchObject({ converted: '10', remaining: '0' });
  });
  it('a revision of a DO keeps its delivered mark (only a QT clears marks)', () => {
    const d = createDraft(st, co, 'DO', { header: { partyId: cust, documentDate: '2026-10-14' }, lines: [line()] }, me, 'do-1');
    const i = issue(st, d.id, d.version, me);
    const m = setMark(st, d.id, 'delivered', i.version, me);
    const r = revise(st, d.id, { header: m.header, lines: m.lines }, m.version, 'x', me);
    expect(r.marks?.delivered).toBeDefined();
  });
});
