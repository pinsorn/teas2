import { beforeEach, describe, expect, it } from 'vitest';
import type { Doc, DocType } from '@/domain/types';
import { assertBalanced, type Actor, type DocLine, type MockStateLike } from './test-helpers';
import { seed } from '../store';
import { buildChain } from './chain';
import { cancel, convert, createDraft, deleteDraft, issue, revise } from './commands';
import { closeRemainder, remainingOf, setMark } from './marks';

const me: Actor = { kind: 'user', id: 'u-1', name: 'สมศรี บัญชีดี' };
const line = (id: string, qty: string, p: Partial<DocLine> = {}): DocLine => ({ id, description: `รายการ ${id}`, qty, unit: 'ชิ้น', unitPrice: '100.00', taxCode: 'S7', ...p });
let st: MockStateLike;
let co: string;
let cust: string;
let n = 0;

beforeEach(() => {
  st = seed();
  co = st.companies.find((c) => c.vatRegistered)!.id;
  cust = st.parties.find((p) => p.companyId === co && p.kind === 'customer' && p.vatRegistered && p.taxId)!.id;
});
const make = (type: DocType) => {
  const d = createDraft(st, co, type, { header: { partyId: cust, documentDate: '2026-10-14' }, lines: [line('l1', '20'), line('l2', '10')] }, me, `k-${++n}`);
  return issue(st, d.id, d.version, me);
};
const get = (id: string) => st.docs.find((d) => d.id === id)!;
const progress = (id: string) => buildChain(st, id).nodes.find((x) => x.id === id)?.progress;
const toDo = (so: Doc, lines: { sourceLineId: string; qty: string }[], doIssue = true) => {
  const d = convert(st, so.id, 'DO', lines, me);
  return doIssue ? issue(st, d.id, d.version, me) : d;
};

describe('SO / DO progress (derived, §7.11)', () => {
  it('SO progress = Σ issued DO qty / Σ SO qty; cancelling or deleting a DO returns the quantity', () => {
    const so = make('SO');
    expect(progress(so.id)).toBe('ส่งแล้ว 0/30');
    const draft = toDo(so, [{ sourceLineId: 'l1', qty: '10' }], false);
    expect(progress(so.id)).toBe('ส่งแล้ว 0/30'); // a draft DO reserves quantity but has delivered nothing
    expect(remainingOf(st, so.id)[0].remaining).toBe('10');
    deleteDraft(st, draft.id, draft.version, me);
    expect(remainingOf(st, so.id)[0].remaining).toBe('20'); // deleting the draft returns it
    const d1 = toDo(so, [{ sourceLineId: 'l1', qty: '10' }]);
    expect(progress(so.id)).toBe('ส่งแล้ว 10/30');
    cancel(st, d1.id, d1.version, 'OTHER', 'x', me);
    expect(progress(so.id)).toBe('ส่งแล้ว 0/30'); // cancelling it returns it
    expect(remainingOf(st, so.id)[0]).toMatchObject({ converted: '0', remaining: '20' });
    toDo(so, [{ sourceLineId: 'l1', qty: '20' }, { sourceLineId: 'l2', qty: '10' }]);
    expect(progress(so.id)).toBe('ส่งครบ');
    assertBalanced(st);
  });
  it('a TI taken from the SO is not a delivery', () => {
    const so = make('SO');
    convert(st, so.id, 'TI', [{ sourceLineId: 'l1', qty: '5' }], me);
    expect(progress(so.id)).toBe('ส่งแล้ว 0/30');
  });
  it('DO progress = billed qty / DO qty ("วางบิลแล้ว x/y")', () => {
    const d = toDo(make('SO'), [{ sourceLineId: 'l1', qty: '10' }]);
    expect(progress(d.id)).toBe('วางบิลแล้ว 0/10');
    convert(st, d.id, 'TI', [{ sourceLineId: d.lines[0].id, qty: '4' }], me);
    expect(progress(d.id)).toBe('วางบิลแล้ว 4/10');
  });
  it('DO → BL conversion is refused (D-07), and the refusal leaves nothing behind', () => {
    const d = toDo(make('SO'), [{ sourceLineId: 'l1', qty: '10' }]);
    const links = st.links.length;
    expect(() => convert(st, d.id, 'BL', [{ sourceLineId: d.lines[0].id, qty: '1' }], me)).toThrow(/doc\.conversion_not_allowed/);
    expect(st.links).toHaveLength(links);
  });
  it('the delivered mark on a DO is status-only: no TI, no revision, totals unchanged', () => {
    const d = toDo(make('SO'), [{ sourceLineId: 'l1', qty: '10' }]);
    const tis = st.docs.filter((x) => x.type === 'TI').length;
    const m = setMark(st, d.id, 'delivered', d.version, me);
    expect(m.marks?.delivered).toBeDefined();
    expect([st.docs.filter((x) => x.type === 'TI').length, m.revision, m.totals]).toEqual([tis, d.revision, d.totals]);
  });
});

describe('close remainder', () => {
  it('sets remaining 0 for every line, marks closed, appends to progress; a revision of the SO clears it (the exit)', () => {
    const so = make('SO');
    toDo(so, [{ sourceLineId: 'l1', qty: '10' }]);
    const before = get(so.id);
    const c = closeRemainder(st, so.id, before.version, 'ลูกค้าไม่รับส่วนที่เหลือ', me);
    expect(c.marks?.closed).toMatchObject({ reason: 'ลูกค้าไม่รับส่วนที่เหลือ', by: me.name });
    expect(remainingOf(st, so.id).map((l) => [l.remaining, l.closed])).toEqual([['0', true], ['0', true]]);
    expect(remainingOf(st, so.id)[0].converted).toBe('10'); // what went out is still shown
    expect(progress(so.id)).toBe('ส่งแล้ว 10/30 (ปิดยอดคงเหลือ)');
    expect([c.revision, c.totals, c.version]).toEqual([so.revision, so.totals, before.version + 1]); // a mark: no revision, no totals change
    expect(() => convert(st, so.id, 'DO', [{ sourceLineId: 'l1', qty: '1' }], me)).toThrow(/doc\.closed.*แก้ไข/);
    expect(() => convert(st, so.id, 'TI', [{ sourceLineId: 'l1', qty: '1' }], me)).toThrow(/doc\.closed/);
    const rev = revise(st, so.id, { header: c.header, lines: c.lines }, c.version, 'เปิดใหม่', me);
    expect(rev.marks?.closed).toBeUndefined();
    expect(remainingOf(st, so.id).map((l) => [l.remaining, l.closed])).toEqual([['10', false], ['10', false]]);
    expect(progress(so.id)).toBe('ส่งแล้ว 10/30');
    convert(st, so.id, 'DO', [{ sourceLineId: 'l1', qty: '1' }], me); // converts again
  });
  it('same trail as /marks: activity + doc.mark audit with before / after, no revision row', () => {
    const so = make('SO');
    const revs = st.revisions.filter((r) => r.docId === so.id).length;
    const c = closeRemainder(st, so.id, so.version, 'เหตุผล', me);
    expect(st.activity.filter((a) => a.docId === so.id).at(-1)).toMatchObject({ action: 'close', detail: 'เหตุผล' });
    const aud = st.audit.filter((a) => a.command === 'doc.mark' && a.target === so.id);
    expect(aud).toHaveLength(1);
    expect(aud[0].before).toEqual({ marks: undefined });
    expect((aud[0].after as { marks: { closed: unknown } }).marks.closed).toEqual(c.marks?.closed);
    expect(st.revisions.filter((r) => r.docId === so.id)).toHaveLength(revs);
  });
  it('needs a reason, a live document, the current version, an N-class type, and is not repeated', () => {
    const so = make('SO');
    expect(() => closeRemainder(st, so.id, so.version, '  ', me)).toThrow(/mark\.reason_required/);
    expect(() => closeRemainder(st, so.id, so.version + 2, 'x', me)).toThrow(/doc\.version_conflict/);
    const draft = createDraft(st, co, 'SO', { header: { partyId: cust, documentDate: '2026-10-14' }, lines: [line('l1', '1')] }, me, 'k-d');
    expect(() => closeRemainder(st, draft.id, draft.version, 'x', me)).toThrow(/doc\.not_live/);
    const ti = createDraft(st, co, 'TI', { header: { partyId: cust, documentDate: '2026-10-14' }, lines: [line('l1', '1')] }, me, 'k-t');
    const tiI = issue(st, ti.id, ti.version, me);
    expect(() => closeRemainder(st, tiI.id, tiI.version, 'x', me)).toThrow(/mark\.not_allowed/);
    const qt = make('QT');
    expect(() => closeRemainder(st, qt.id, qt.version, 'x', me)).toThrow(/mark\.not_allowed/);
    const c = closeRemainder(st, so.id, so.version, 'x', me);
    expect(() => closeRemainder(st, so.id, c.version, 'y', me)).toThrow(/doc\.already_closed/);
    expect(so.marks?.closed).toBeUndefined();
  });
  it('a DO can be closed too, and revising a DO keeps its delivered mark but clears closed', () => {
    const d = toDo(make('SO'), [{ sourceLineId: 'l1', qty: '10' }]);
    const dl = setMark(st, d.id, 'delivered', d.version, me);
    const c = closeRemainder(st, d.id, dl.version, 'x', me);
    const r = revise(st, d.id, { header: c.header, lines: c.lines }, c.version, 'y', me);
    expect([r.marks?.delivered !== undefined, r.marks?.closed]).toEqual([true, undefined]);
  });
});

describe('S2 seed', () => {
  it('the sales orders and delivery orders come out of the engine in the promised states, invariants hold', () => {
    const by = (id: string) => get(id);
    expect(by('so-d1').status).toBe('draft');
    expect(by('so-part').lines.map((l) => l.qty)).toEqual(['20', '10']);
    expect(progress('so-part')).toBe('ส่งแล้ว 10/30');
    expect(by('do-part').status).toBe('issued');
    expect(by('so-closed').marks?.closed?.reason).toBe('ลูกค้าขอยกเลิกส่วนที่เหลือ');
    expect(by('do-dlv').marks?.delivered).toBeDefined();
    expect(st.links.some((l) => l.from === 'do-dlv' && l.to === 'so-u1' && l.kind === 'converted_from' && l.active)).toBe(true);
    expect([by('nso-1').companyId, by('nso-1').status, by('ndo-1').marks?.delivered !== undefined]).toEqual(['co-nonvat', 'issued', true]);
    expect(st.links.some((l) => l.from === 'nso-1' && l.to === 'nqt-2')).toBe(true);
    assertBalanced(st);
  });
});
