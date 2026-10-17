import { beforeEach, describe, expect, it } from 'vitest';
import { seed, type MockState } from '../../store';
import { checkInvariants } from '../invariants';
import { filingHistory } from '../filings';
import { VAT_THRESHOLD, thresholdLevel, vatThresholdWatch } from '../vat-threshold';
import { buildReport } from './index';
import { formCatalogue, taxSummary } from './tax-summary';

// TX3b on the seed: the tax summary (ruling 1), the VAT threshold watch (ruling 2), the form catalogue and the filing history (ruling 3).
let st: MockState;
beforeEach(() => { st = seed(); });
const cell = (co: string, year: string, month: string, key: string, perms = true) => taxSummary(st, co, { year }, perms).rows.find((r) => r.cells.month?.startsWith(month))!.cells[key] ?? '';

describe('VAT threshold watch (G1)', () => {
  const sat = (baht: number) => Math.round(baht * 100);
  it('fires at 80 % and 100 % exactly, not a satang earlier', () => {
    expect(VAT_THRESHOLD).toBe('1800000.00');
    expect(thresholdLevel(sat(1_439_999.99))).toBe('ok');   // 79.99 %
    expect(thresholdLevel(sat(1_440_000))).toBe('warning'); // 80.00 %
    expect(thresholdLevel(sat(1_799_999.99))).toBe('warning');
    expect(thresholdLevel(sat(1_800_000))).toBe('danger');  // 100.00 %
  });
  it('the non-VAT seed company sits near 85 % with the warning; a VAT company never has the card', () => {
    const w = vatThresholdWatch(st, 'co-nonvat')!;
    expect(w.level).toBe('warning');
    expect(Number(w.percent)).toBeGreaterThanOrEqual(84.5);
    expect(Number(w.percent)).toBeLessThan(86);
    expect(w.messageTh).toBe('ใกล้เกณฑ์ต้องจดทะเบียนภาษีมูลค่าเพิ่ม');
    expect(w.to).toBe('2026-10-31');
    expect(w.from).toBe('2025-11-01');
    expect(vatThresholdWatch(st, 'co-vat')).toBeNull();
  });
  it('counts IV + RC cash bills + TI less CN plus DN, live documents only, inside the rolling 12 months', () => {
    const before = vatThresholdWatch(st, 'co-nonvat')!.revenue;
    const iv = st.docs.find((d) => d.companyId === 'co-nonvat' && d.type === 'IV' && d.status === 'issued' && d.header.documentDate >= '2025-11-01')!;
    iv.status = 'cancelled';
    expect(Number(vatThresholdWatch(st, 'co-nonvat')!.revenue)).toBeCloseTo(Number(before) - Number(iv.totals.net), 2);
    iv.status = 'issued'; iv.header.documentDate = '2025-10-31'; // one day outside the window
    expect(Number(vatThresholdWatch(st, 'co-nonvat')!.revenue)).toBeCloseTo(Number(before) - Number(iv.totals.net), 2);
  });
});

describe('tax summary (ruling 1)', () => {
  it('VAT company: 12 months; a finalized month reads its snapshot; the status chips say finalized / owed / na', () => {
    const m = taxSummary(st, 'co-vat', { year: '2026' }, true);
    expect(m.kind).toBe('tax-summary');
    expect(m.rows.filter((r) => r.kind === 'row')).toHaveLength(12);
    expect(cell('co-vat', '2026', 'ก.ค.', 'outVat')).toBe(st.filings.find((f) => f.form === 'PP30' && f.period === '2026-07')!.boxes.find((b) => b.code === '5')!.amount);
    expect(cell('co-vat', '2026', 'ก.ค.', 'status')).toContain('ภ.พ.30:finalized');
    expect(cell('co-vat', '2026', 'ก.ย.', 'status')).toContain('ภ.ง.ด.53:finalized');
    expect(cell('co-vat', '2026', 'ม.ค.', 'status')).not.toContain('ภ.พ.30:finalized');
    expect(cell('co-vat', '2026', 'ธ.ค.', 'status')).toBe(''); // a future month owes nothing
  });
  it('a finalized month is its snapshot even after a document moves (never recomputed)', () => {
    const was = cell('co-vat', '2026', 'ส.ค.', 'outVat');
    const f = st.filings.find((x) => x.form === 'PP30' && x.period === '2026-08')!;
    expect(was).toBe(f.boxes.find((b) => b.code === '5')!.amount);
    f.boxes = f.boxes.map((b) => (b.code === '5' ? { ...b, amount: '1.23' } : b));
    expect(cell('co-vat', '2026', 'ส.ค.', 'outVat')).toBe('1.23');
  });
  it('an unfiled month shows computed cells only with the preview right; without it, status only', () => {
    expect(cell('co-vat', '2026', 'ต.ค.', 'outVat', true)).not.toBe('');
    expect(cell('co-vat', '2026', 'ต.ค.', 'outVat', false)).toBe('');
    expect(cell('co-vat', '2026', 'ต.ค.', 'status', false)).toContain('ภ.พ.30');
    expect(cell('co-vat', '2026', 'ส.ค.', 'outVat', false)).not.toBe(''); // a finalized month needs no preview
  });
  it('status owed uses the same rule as the close checklist (unfiledForms)', () => {
    expect(cell('co-vat', '2026', 'ก.ย.', 'status')).toContain('ภ.พ.30:owed');
  });
  it('non-VAT company: no VAT columns, a sales column, a threshold note-free table', () => {
    const m = taxSummary(st, 'co-nonvat', { year: '2026' }, true);
    expect(m.columns.map((c) => c.key)).not.toContain('outVat');
    expect(m.columns.map((c) => c.key)).not.toContain('netVat');
    expect(m.columns.map((c) => c.key)).toContain('sales');
    expect(Number(cell('co-nonvat', '2026', 'ต.ค.', 'sales'))).toBeGreaterThan(0);
  });
  it('is a registered report kind and a bad year is refused', () => {
    expect(buildReport(st, 'co-vat', 'tax-summary', { year: '2026' }).kind).toBe('tax-summary');
    expect(() => taxSummary(st, 'co-vat', { year: 'abc' }, true)).toThrow();
  });
});

describe('form catalogue and filing history (ruling 3)', () => {
  it('lists every form with its period kind, due day and last finalized period', () => {
    const c = formCatalogue(st, 'co-vat');
    expect(c.forms.map((f) => f.form)).toEqual(['PP30', 'PP36', 'PND2', 'PND3', 'PND53', 'PND54', 'PND50', 'PND51', 'PP01', 'PP09']);
    expect(c.forms.find((f) => f.form === 'PP30')).toMatchObject({ periodKind: 'month', lastFinalized: '2026-08', href: '/tax/vat' });
    expect(c.forms.find((f) => f.form === 'PND3')).toMatchObject({ lastFinalized: '2026-09', href: '/tax/wht?tab=pnd3' });
    expect(c.forms.find((f) => f.form === 'PND50')).toMatchObject({ periodKind: 'year', lastFinalized: null });
    expect(c.forms.find((f) => f.form === 'PP01')).toMatchObject({ periodKind: 'event', printable: true });
    expect(c.forms.every((f) => f.dueRuleTh.length > 0)).toBe(true);
  });
  it('a non-VAT company has no ภ.พ.30 / ภ.พ.36 row (not available) but keeps the ภ.พ.01 to register', () => {
    const c = formCatalogue(st, 'co-nonvat');
    expect(c.forms.find((f) => f.form === 'PP30')).toBeUndefined();
    expect(c.forms.find((f) => f.form === 'PP01')).toBeDefined();
  });
  it('the history spans all forms, newest first, one row per finalized filing', () => {
    const h = formCatalogue(st, 'co-vat').history;
    expect(h).toHaveLength(st.filings.filter((f) => f.companyId === 'co-vat').length);
    expect(h.map((x) => x.finalizedAt)).toEqual([...h.map((x) => x.finalizedAt)].sort().reverse());
    expect(h.find((x) => x.form === 'PP30' && x.period === '2026-08')).toMatchObject({ finalizedBy: 'สมศรี บัญชีดี', exports: ['rdprep-txt', 'pdf'], href: '/tax/vat?period=2026-08' });
    expect(h.find((x) => x.form === 'PP36')?.exports ?? ['pdf']).toEqual(['pdf']);
    expect(filingHistory(st, 'co-vat', 'PP30')).toHaveLength(h.filter((x) => x.form === 'PP30').length);
  });
});

describe('the seed', () => {
  it('is invariant-clean', () => { expect(checkInvariants(st)).toEqual([]); });
});
