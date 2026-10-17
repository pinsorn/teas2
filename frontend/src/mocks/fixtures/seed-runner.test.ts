import { describe, expect, it } from 'vitest';
import type { DocLine } from '@/domain/types';
import { checkInvariants } from '../engine/invariants';
import { stamp, withFixedClock } from '../engine/log';
import { buildSeedState } from '../store';
import { runSeed, type SeedSpec } from './seed-runner';

const line = (p: Partial<DocLine> = {}): DocLine => ({ id: 'l1', description: 'ออกแบบ', qty: '1', unit: 'งาน', unitPrice: '1000.00', taxCode: 'S7', ...p });
const customer = (st: ReturnType<typeof buildSeedState>) => st.parties.find((p) => p.companyId === 'co-vat' && p.kind === 'customer' && p.vatRegistered && p.taxId)!.id;
const ti = (st: ReturnType<typeof buildSeedState>, id: string, date: string, over: Partial<SeedSpec> = {}): SeedSpec =>
  ({ id, type: 'TI', companyId: 'co-vat', date, partyId: customer(st), lines: [line()], status: 'issued', ...over });

describe('withFixedClock', () => {
  it('stamp() returns the pinned instant plus one second per call, and the real clock again afterwards', () => {
    const a = withFixedClock('2025-06-10T10:00:00+07:00', () => [stamp(), stamp(), stamp()]);
    expect(a).toEqual(['2025-06-10T03:00:00.000Z', '2025-06-10T03:00:01.000Z', '2025-06-10T03:00:02.000Z']);
    expect(Date.parse(stamp())).toBeGreaterThan(Date.parse('2025-06-10T03:00:03.000Z'));
  });
  it('restores the real clock when fn throws', () => {
    expect(() => withFixedClock('2025-06-10T10:00:00+07:00', () => { throw new Error('x'); })).toThrow('x');
    expect(stamp().startsWith('2025-06-10T03:00')).toBe(false);
  });
});

describe('runSeed (D-23)', () => {
  it('creates documents through the engine with the explicit id, a number, a journal and the pinned clock', () => {
    const st = buildSeedState(); const before = st.docs.length;
    runSeed(st, [ti(st, 'seed-x1', '2025-06-10')]); // a closed month: history is issued at its own date
    const d = st.docs.find((x) => x.id === 'seed-x1')!;
    expect(st.docs).toHaveLength(before + 1);
    expect([d.status, d.number, d.header.documentDate]).toEqual(['issued', 'TI-202506-0001', '2025-06-10']);
    expect(d.issuedAt).toMatch(/^2025-06-10T0[0-9]:00:/); // pinned clock, not the real one
    expect(st.journals.find((j) => j.docId === 'seed-x1')!.preview.entries[0].kind).toBe('original');
    expect(checkInvariants(st)).toEqual([]);
  });
  it('executes in (date, list order) so numbering follows the dates', () => {
    const st = buildSeedState();
    runSeed(st, [ti(st, 'late', '2025-06-20'), ti(st, 'early', '2025-06-05'), ti(st, 'early2', '2025-06-05')]);
    const n = (id: string) => st.docs.find((x) => x.id === id)!.number;
    expect([n('early'), n('early2'), n('late')]).toEqual(['TI-202506-0001', 'TI-202506-0002', 'TI-202506-0003']);
  });
  it('drafts stay drafts; cancelled specs are issued then cancelled (journal gets its reversal)', () => {
    const st = buildSeedState();
    runSeed(st, [ti(st, 'dr', '2026-09-03', { status: 'draft' }), ti(st, 'cx', '2026-09-04', { status: 'cancelled' })]);
    expect(st.docs.find((x) => x.id === 'dr')!.status).toBe('draft');
    expect(st.docs.find((x) => x.id === 'cx')!.status).toBe('cancelled');
    expect(st.journals.find((j) => j.docId === 'cx')!.preview.entries.map((e) => [e.kind, e.date, e.late ?? false])).toEqual([['original', '2026-09-04', false], ['reversal', '2026-09-04', false]]);
    expect(checkInvariants(st)).toEqual([]);
  });
  it('a cancellation inside a closed month reverses on its own (pinned) date, not late', () => {
    const st = buildSeedState();
    runSeed(st, [ti(st, 'cx2', '2025-06-12', { status: 'cancelled' })]);
    expect(st.journals.find((j) => j.docId === 'cx2')!.preview.entries.map((e) => [e.kind, e.date, e.late ?? false])).toEqual([['original', '2025-06-12', false], ['reversal', '2025-06-12', false]]);
    expect(checkInvariants(st)).toEqual([]);
  });
  it('a converted draft keeps its source priceIncludesVat', () => {
    const st = buildSeedState();
    runSeed(st, [
      { id: 'qt-v', type: 'QT', companyId: 'co-vat', date: '2026-08-01', partyId: customer(st), lines: [line({ id: 'q1' })], status: 'issued', header: { priceIncludesVat: true } },
      { id: 'so-v', type: 'SO', companyId: 'co-vat', date: '2026-08-02', lines: [], status: 'draft', convertFrom: { id: 'qt-v', lines: [{ sourceLineId: 'q1', qty: '1' }] } },
    ]);
    expect(st.docs.find((d) => d.id === 'so-v')!.header.priceIncludesVat).toBe(true);
  });
  it('convertFrom converts the listed source lines and the `after` hook sees the finished state', () => {
    const st = buildSeedState(); let seen = '';
    runSeed(st, [
      { id: 'qt-x', type: 'QT', companyId: 'co-vat', date: '2026-08-01', partyId: customer(st), lines: [line({ id: 'q1' })], status: 'issued' },
      { id: 'so-x', type: 'SO', companyId: 'co-vat', date: '2026-08-02', lines: [], status: 'issued', convertFrom: { id: 'qt-x', lines: [{ sourceLineId: 'q1', qty: '1' }] },
        after: (s) => { seen = s.docs.find((x) => x.id === 'so-x')!.status; } },
    ]);
    expect(seen).toBe('issued');
    expect(st.links.some((l) => l.kind === 'converted_from' && l.from === 'so-x' && l.to === 'qt-x' && l.active)).toBe(true);
    expect(checkInvariants(st)).toEqual([]);
  });
  it('throws naming the spec id on any engine error (can fail)', () => {
    const st = buildSeedState();
    expect(() => runSeed(st, [ti(st, 'bad-one', '2026-08-03', { partyId: undefined })])).toThrow(/bad-one.*doc\.incomplete/);
  });
  it('refuses a duplicate id', () => {
    const st = buildSeedState();
    expect(() => runSeed(st, [ti(st, 'dup', '2026-08-03'), ti(st, 'dup', '2026-08-04')])).toThrow(/dup/);
  });
});
