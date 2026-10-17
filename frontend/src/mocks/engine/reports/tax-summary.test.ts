import { beforeEach, describe, expect, it } from 'vitest';
import en from '@/messages/en.json';
import th from '@/messages/th.json';
import { seed, type MockState } from '../../store';
import { checkInvariants } from '../invariants';
import { filingHistory } from '../filings';
import { VAT_THRESHOLD, thresholdLevel, vatThresholdWatch } from '../vat-threshold';
import { buildReport } from './index';
import { formCatalogue, taxSummary } from './tax-summary';

// TX3b on the seed: the tax summary (ruling 1), the VAT threshold watch (ruling 2), the form catalogue and the filing history (ruling 3).
let st: MockState;
beforeEach(() => { st = seed(); });
const chipsOf = (co: string, year: string, month: string, perms = true) => taxSummary(st, co, { year }, perms).rows.find((r) => r.cells.month?.startsWith(month))!.chips ?? [];
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
    expect([w.percent, w.revenue]).toEqual(['85.00', '1530000.00']); // 34,860.00 + 5 x 299,028.00
    expect('messageTh' in w).toBe(false); // F6: the card words the message from the locale's messages
    for (const m of [th, en]) expect(Object.keys(m.taxPage.threshold.message).sort()).toEqual(['danger', 'warning']);
    expect(w.to).toBe('2026-10-31');
    expect(w.from).toBe('2025-11-01');
    expect(vatThresholdWatch(st, 'co-vat')).toBeNull();
  });
  // F4: documents built by hand so each rule moves the revenue by exactly its amount (the non-VAT seed company has none other of these kinds)
  const doc = (type: string, net: string, allocations?: unknown[]) => st.docs.push({ id: `zz-${st.docs.length}`, companyId: 'co-nonvat', type, status: 'issued', header: { documentDate: '2026-10-05' }, totals: { net }, ...(allocations ? { allocations } : {}) } as never);
  const rev = () => vatThresholdWatch(st, 'co-nonvat')!.revenue;
  it('an RC with an allocation is excluded (it settles an invoice already counted); an RC cash bill counts; a CN subtracts; a DN adds', () => {
    doc('RC', '1000.00', [{ docId: 'x', amount: '1000.00' }]); expect(rev()).toBe('1530000.00');
    doc('RC', '1000.00'); expect(rev()).toBe('1531000.00');
    doc('CN', '400.00'); expect(rev()).toBe('1530600.00');
    doc('DN', '50.00'); expect(rev()).toBe('1530650.00');
    doc('TI', '350.00'); expect(rev()).toBe('1531000.00');
  });
  it('percent strings at the edges: 79.99 / 80.00 / 100.00 agree with the level', () => {
    st.docs = st.docs.filter((d) => d.companyId !== 'co-nonvat');
    doc('TI', '1439999.99'); expect(vatThresholdWatch(st, 'co-nonvat')).toMatchObject({ percent: '79.99', level: 'ok' });
    st.docs.pop(); doc('TI', '1440000.00'); expect(vatThresholdWatch(st, 'co-nonvat')).toMatchObject({ percent: '80.00', level: 'warning' });
    st.docs.pop(); doc('TI', '1800000.00'); expect(vatThresholdWatch(st, 'co-nonvat')).toMatchObject({ percent: '100.00', level: 'danger' });
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
    expect(chipsOf('co-vat', '2026', 'ก.ค.')).toContainEqual({ form: 'ภ.พ.30', state: 'finalized', href: '/tax/vat?period=2026-07' }); // F3: typed chips, not a packed string
    expect(chipsOf('co-vat', '2026', 'ก.ย.')).toContainEqual(expect.objectContaining({ form: 'ภ.ง.ด.53', state: 'finalized' }));
    expect(chipsOf('co-vat', '2026', 'ม.ค.')).not.toContainEqual(expect.objectContaining({ form: 'ภ.พ.30', state: 'finalized' }));
    expect(chipsOf('co-vat', '2026', 'ธ.ค.')).toEqual([]); // a future month owes nothing
    expect(cell('co-vat', '2026', 'ก.ค.', 'status')).toBe('');
  });
  it('F1: net VAT is the month\'s own output less input; a carry-in (box 10) does not move it', () => {
    const f = st.filings.find((x) => x.form === 'PP30' && x.period === '2026-08')!;
    const set = (code: string, amount: string) => { f.boxes = f.boxes.map((b) => (b.code === code ? { ...b, amount } : b)); };
    set('5', '100.00'); set('7', '50.00'); set('10', '30.00'); set('8', '50.00'); set('9', '0.00'); set('11', '20.00'); set('12', '0.00'); // box 8 is the month's own 50; payable after the carry-in (box 11) is 20
    expect(cell('co-vat', '2026', 'ส.ค.', 'netVat')).toBe('50.00');
    set('5', '40.00'); expect(cell('co-vat', '2026', 'ส.ค.', 'netVat')).toBe('-10.00'); // signed
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
    expect(chipsOf('co-vat', '2026', 'ต.ค.', false).some((c) => c.form === 'ภ.พ.30')).toBe(true);
    expect(cell('co-vat', '2026', 'ส.ค.', 'outVat', false)).not.toBe(''); // a finalized month needs no preview
  });
  it('status owed uses the same rule as the close checklist (unfiledForms)', () => {
    expect(chipsOf('co-vat', '2026', 'ก.ย.')).toContainEqual(expect.objectContaining({ form: 'ภ.พ.30', state: 'owed' }));
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
