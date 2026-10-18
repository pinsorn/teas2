import { beforeEach, describe, expect, it } from 'vitest';
import type { ReportModel } from '@/domain/reports';
import { buildSeedState, type MockState } from '../../store';
import { progressOf, q4 } from '../chain';
import { cancel, convert, issue } from '../commands';
import { today } from '../log';
import { outstandingPo } from './outstanding-po';

const VAT = 'co-vat', NV = 'co-nonvat';
const ME = { kind: 'user' as const, id: 'u-1', name: 'สมศรี บัญชีดี' };
let st: MockState;
beforeEach(() => { localStorage.clear(); st = buildSeedState(); });
const pos = (m: ReportModel) => m.rows.filter((r) => r.kind === 'group').map((r) => r.cells.po);
const lines = (m: ReportModel, po: string) => {
  const out: ReportModel['rows'] = []; let on = false;
  for (const r of m.rows) { if (r.kind === 'group') on = r.cells.po === po; else if (on && r.kind === 'row') out.push(r); }
  return out;
};
const num = (id: string) => st.docs.find((d) => d.id === id)!.number!;
const err = (fn: () => unknown) => { try { fn(); } catch (e) { return e as { status?: number }; } return undefined; };

describe('ruling 5: outstanding purchase orders', () => {
  it('lists the issued POs with something left to bill; a draft, a closed and another company\'s PO are not there', () => {
    const m = outstandingPo(st, VAT, { asOf: today() });
    expect(pos(m)).toEqual(expect.arrayContaining([num('po-1'), num('po-part')]));
    expect(pos(m)).not.toContain(num('po-d1'));
    expect(pos(m)).not.toContain(num('po-closed'));
    expect(pos(m)).not.toContain(num('npo-1'));
    expect(pos(outstandingPo(st, NV, { asOf: today() }))).toEqual([num('npo-1')]);
  });
  it('ordered - billed per line, billed counting the issued PB lines of the PO (the PO progress function, not a recount)', () => {
    const m = outstandingPo(st, VAT, { asOf: today() });
    const part = lines(m, num('po-part'));
    expect(part.map((r) => [r.cells.ordered, r.cells.billed, r.cells.remaining])).toEqual([['40', '20', '20'], ['100', '50', '50']]);
    for (const id of ['po-1', 'po-part']) {
      const d = st.docs.find((x) => x.id === id)!;
      const [done, ordered] = progressOf(st, d)!.match(/(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)/)!.slice(1).map(q4);
      const mine = lines(m, d.number!);
      expect(mine.reduce((n, r) => n + q4(r.cells.billed), 0)).toBe(done);
      expect(mine.reduce((n, r) => n + q4(r.cells.ordered), 0)).toBe(ordered);
    }
    expect(lines(m, num('po-1')).every((r) => r.cells.billed === '0')).toBe(true);
  });
  it('as of a date: a PB issued after it has not billed anything yet, and a PO dated after it is not there', () => {
    const before = outstandingPo(st, VAT, { asOf: '2026-10-11' }); // pb-po is dated 2026-10-12
    expect(lines(before, num('po-part')).map((r) => r.cells.billed)).toEqual(['0', '0']);
    expect(pos(before)).not.toContain(num('po-1')); // dated 2026-10-12
    const on = outstandingPo(st, VAT, { asOf: '2026-10-12' });
    expect(lines(on, num('po-part')).map((r) => r.cells.billed)).toEqual(['20', '50']);
    expect(pos(on)).toContain(num('po-1'));
  });
  it('overdue = the expected date is before the date (the day itself is not late); overdueOnly keeps only those', () => {
    const exp = st.docs.find((d) => d.id === 'po-1')!.header.dueDate!;
    const day = (n: number) => new Date(Date.parse(`${exp}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
    const flag = (m: ReportModel) => m.rows.find((r) => r.kind === 'group' && r.cells.po === num('po-1'))?.cells.status;
    expect(flag(outstandingPo(st, VAT, { asOf: exp }))).toBe('');
    expect(flag(outstandingPo(st, VAT, { asOf: day(1) }))).toBe('เลยกำหนด');
    expect(pos(outstandingPo(st, VAT, { asOf: exp, overdueOnly: 'true' }))).not.toContain(num('po-1'));
    expect(pos(outstandingPo(st, VAT, { asOf: day(1), overdueOnly: 'true' }))).toEqual(expect.arrayContaining([num('po-1')]));
    expect(pos(outstandingPo(st, VAT, { asOf: today(), overdueOnly: 'true' }))).toEqual([]); // nothing is late on the seed's own day
  });
  it('a cancelled PO is not there', () => {
    const po = st.docs.find((d) => d.id === 'po-1')!;
    cancel(st, po.id, po.version, 'other', 'ทดสอบ', ME);
    expect(pos(outstandingPo(st, VAT, { asOf: today() }))).not.toContain(po.number);
  });
  it('a draft bill only reserves (billed stays); once issued it bills, from its own date', () => {
    const po = st.docs.find((d) => d.id === 'po-1')!;
    const billed = (asOf: string) => lines(outstandingPo(st, VAT, { asOf }), num('po-1')).map((r) => r.cells.billed);
    const draft = convert(st, po.id, 'PB', [{ sourceLineId: po.lines[0].id, qty: '3' }], ME);
    expect(billed(today())).toEqual(['0', '0', '0']);
    issue(st, draft.id, draft.version, ME);
    expect(billed(today())).toEqual(['3', '0', '0']);
    expect(lines(outstandingPo(st, VAT, { asOf: today() }), num('po-1'))[0].cells.remaining).toBe('9');
    expect(billed('2026-10-13')).toEqual(['0', '0', '0']); // the bill is dated today
  });
  it('RP2a m4: a bill dated before the date and cancelled after it still counts on the date, until its reversal; the report says what it reads as of now', () => {
    const po = st.docs.find((d) => d.id === 'po-1')!;
    const billed = (asOf: string) => lines(outstandingPo(st, VAT, { asOf }), num('po-1')).map((r) => r.cells.billed);
    const draft = convert(st, po.id, 'PB', [{ sourceLineId: po.lines[0].id, qty: '3' }], ME);
    st.docs.find((d) => d.id === draft.id)!.header.documentDate = '2026-10-13'; // a bill of an earlier day (setup only)
    const pb = issue(st, draft.id, draft.version, ME);
    expect(billed('2026-10-12')).toEqual(['0', '0', '0']);
    expect(billed('2026-10-13')).toEqual(['3', '0', '0']);
    cancel(st, pb.id, pb.version, 'other', 'ทดสอบ', ME); // reversed today
    const dayBefore = new Date(Date.parse(`${today()}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    expect(billed('2026-10-13')).toEqual(['3', '0', '0']); // the cancel does not reach back
    expect(billed(dayBefore)).toEqual(['3', '0', '0']);
    expect(billed(today())).toEqual(['0', '0', '0']); // gone on the day of its reversal
    expect(outstandingPo(st, VAT, { asOf: today() }).notes?.join(' ')).toContain('ปัจจุบัน');
  });
  it('refusals and model', () => {
    expect(err(() => outstandingPo(st, VAT, { asOf: '2026-02-30' }))).toMatchObject({ status: 422 });
    expect(err(() => outstandingPo(st, VAT, { overdueOnly: 'maybe' }))).toMatchObject({ status: 422 });
    const m = outstandingPo(st, VAT, {});
    expect(m).toMatchObject({ kind: 'outstanding-po', asOf: today() });
    expect(m.columns.map((c) => c.key)).toEqual(['po', 'vendor', 'expected', 'item', 'ordered', 'billed', 'remaining', 'status']);
  });
});
