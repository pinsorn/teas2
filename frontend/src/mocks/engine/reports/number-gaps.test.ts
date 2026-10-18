import { beforeEach, describe, expect, it } from 'vitest';
import { reportPermission } from '@/domain/reports';
import { buildSeedState, type MockState } from '../../store';
import { checkInvariants } from '../invariants';
import { buildReport } from './index';
import { numberGaps } from './number-gaps';

const VAT = 'co-vat', NV = 'co-nonvat';
let st: MockState;
beforeEach(() => { localStorage.clear(); st = buildSeedState(); });

const series = (m: ReturnType<typeof numberGaps>) => m.rows.filter((r) => r.level === 0);
const child = (m: ReturnType<typeof numberGaps>, state: string) => m.rows.filter((r) => r.level === 1 && r.cells.state === state);
/** A series of the company with at least `min` numbered documents, and its documents in number order. */
const pick = (co: string, min: number) => {
  for (const [k, n] of Object.entries(st.series)) {
    if (!k.startsWith(`${co}|`) || n < min) continue;
    const [, type, month] = k.split('|');
    const docs = st.docs.filter((d) => d.companyId === co && d.type === type && !d.header.obBatchId && d.number?.startsWith(`${type}-${month.replace('-', '')}-`)).sort((a, b) => a.number!.localeCompare(b.number!));
    if (docs.length === n) return { key: k, type, month, docs };
  }
  throw new Error('no series');
};
const about = (co: string, k: string) => { const [, type, month] = k.split('|'); return numberGaps(st, co, { year: month.slice(0, 4), month: month.slice(5), type }); };

describe('ruling 1: number gaps and duplicates', () => {
  it.each([VAT, NV])('%s: the seed has no gaps and every series of the company is listed as checked', (co) => {
    const m = numberGaps(st, co, {});
    const keys = Object.keys(st.series).filter((k) => k.startsWith(`${co}|`));
    expect(keys.length).toBeGreaterThan(10);
    expect(series(m)).toHaveLength(keys.length);
    expect(series(m).every((r) => r.cells.state === 'ครบ')).toBe(true);
    expect(child(m, 'เลขขาด')).toHaveLength(0); expect(child(m, 'เลขซ้ำ')).toHaveLength(0); expect(child(m, 'ตัวนับไม่ตรง')).toHaveLength(0);
    expect(numberGaps(st, co, { onlyProblems: 'true' }).rows).toHaveLength(0);
  });
  it('a series row says its counter and how many numbers sit on documents', () => {
    const { key, docs } = pick(VAT, 3);
    const r = series(about(VAT, key))[0];
    expect(r.cells.counter).toBe(String(st.series[key])); expect(r.cells.used).toBe(String(docs.length));
  });

  it('a deleted document (its number was allocated and is on no document) is a gap, named; the series is not ครบ', () => {
    const { key, docs, type, month } = pick(VAT, 3);
    const gone = docs[1];
    st.docs.splice(st.docs.indexOf(gone), 1);
    const m = about(VAT, key);
    expect(series(m)[0].cells.state).toBe('มีปัญหา');
    expect(child(m, 'เลขขาด').map((r) => r.cells.series)).toEqual([gone.number]);
    expect(gone.number).toBe(`${type}-${month.replace('-', '')}-0002`);
  });
  it('a document whose number was removed is a gap too', () => {
    const { key, docs } = pick(VAT, 3);
    const n = docs[2].number; delete docs[2].number;
    expect(child(about(VAT, key), 'เลขขาด').map((r) => r.cells.series)).toEqual([n]);
  });
  it('one number on two documents is a duplicate, listing both; the number that lost its owner is a gap', () => {
    const { key, docs } = pick(VAT, 3);
    const first = docs[0].number!, lost = docs[1].number!;
    docs[1].number = first;
    const m = about(VAT, key);
    const dup = child(m, 'เลขซ้ำ');
    expect(dup).toHaveLength(1);
    expect(dup[0].cells.series).toBe(first);
    expect(dup[0].cells.detail).toContain(docs[0].id); expect(dup[0].cells.detail).toContain(docs[1].id);
    expect(child(m, 'เลขขาด').map((r) => r.cells.series)).toEqual([lost]);
  });
  it('a counter bumped past the highest used number is a gap at the bumped number', () => {
    const { key, docs, type, month } = pick(VAT, 2);
    st.series[key] += 1;
    const m = about(VAT, key);
    expect(child(m, 'เลขขาด').map((r) => r.cells.series)).toEqual([`${type}-${month.replace('-', '')}-${String(docs.length + 1).padStart(4, '0')}`]);
  });
  it('a counter behind the highest number used is reported', () => {
    const { key } = pick(VAT, 2);
    st.series[key] -= 1;
    const m = about(VAT, key);
    expect(series(m)[0].cells.state).toBe('มีปัญหา');
    expect(child(m, 'ตัวนับไม่ตรง')).toHaveLength(1);
  });
  it('a series that exists only as a counter (all its documents gone) is listed with every number a gap', () => {
    const { key, docs } = pick(VAT, 2);
    for (const d of docs) st.docs.splice(st.docs.indexOf(d), 1);
    expect(child(about(VAT, key), 'เลขขาด')).toHaveLength(docs.length);
  });

  it('cancelled numbers are listed with their reason and are never gaps (iv-can)', () => {
    const d = st.docs.find((x) => x.id === 'iv-can')!;
    const m = numberGaps(st, NV, {});
    const c = child(m, 'ยกเลิก').find((r) => r.cells.series === d.number)!;
    expect(c.cells.detail).toContain(d.cancel!.reasonText);
    expect(c.href ?? c.links?.series).toMatch(/\/sales\//);
    expect(child(m, 'เลขขาด')).toHaveLength(0);
  });
  it('a replaced number names the document that replaced it (§7.12 rule 5)', () => {
    const d = st.docs.find((x) => x.id === 'ti-016')!, by = st.docs.find((x) => x.id === d.replacedById)!;
    const c = child(numberGaps(st, VAT, {}), 'ถูกแทนที่').find((r) => r.cells.series === d.number)!;
    expect(c.cells.detail).toContain(by.number);
  });
  it('a cancelled document does not hide a real gap next to it', () => {
    const { key, docs } = pick(NV, 3);
    docs[0].status = 'cancelled'; docs[0].cancel = { reasonCode: 'OTHER', reasonText: 'x', at: '2026-01-01T00:00:00Z' } as never;
    const gone = docs[2]; st.docs.splice(st.docs.indexOf(gone), 1);
    const m = about(NV, key);
    expect(child(m, 'เลขขาด').map((r) => r.cells.series)).toEqual([gone.number]);
    expect(child(m, 'ยกเลิก').map((r) => r.cells.series)).toContain(docs[0].number);
  });

  it('filters: year, month, type, and "only problems"; another company\'s series never appear', () => {
    const all = numberGaps(st, VAT, {});
    const y = numberGaps(st, VAT, { year: '2026' });
    expect(series(y).length).toBeLessThan(series(all).length);
    expect(series(y).every((r) => r.cells.series.includes(' 2026-'))).toBe(true);
    const mo = numberGaps(st, VAT, { year: '2026', month: '7' });
    expect(series(mo).length).toBeGreaterThan(0); expect(series(mo).every((r) => r.cells.series.endsWith(' 2026-07'))).toBe(true);
    expect(series(numberGaps(st, VAT, { type: 'ti' })).every((r) => r.cells.series.startsWith('TI '))).toBe(true);
    const { key, docs } = pick(VAT, 3);
    st.docs.splice(st.docs.indexOf(docs[1]), 1);
    const bad = numberGaps(st, VAT, { onlyProblems: 'true' });
    expect(series(bad)).toHaveLength(1);
    expect(series(bad)[0].cells.series).toContain(key.split('|')[1]);
    expect(series(numberGaps(st, NV, { onlyProblems: 'true' }))).toHaveLength(0);
  });
  it('the report is registered, needs audit.read, and the numbering invariant uses the same parsing (a duplicate trips both)', () => {
    expect(buildReport(st, VAT, 'number-gaps', {}).kind).toBe('number-gaps');
    expect(reportPermission('number-gaps')).toBe('audit.read'); expect(reportPermission('audit-log')).toBe('audit.read'); expect(reportPermission('reopen-history')).toBe('audit.read');
    const { key, docs } = pick(VAT, 3);
    docs[1].number = docs[0].number;
    expect(checkInvariants(st).some((v) => v.includes('numbering'))).toBe(true);
    expect(series(about(VAT, key))[0].cells.state).toBe('มีปัญหา');
  });
});
