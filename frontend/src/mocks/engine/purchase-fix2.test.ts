import { beforeEach, describe, expect, it } from 'vitest';
import type { Doc, DocLine } from '@/domain/types';
import { USER as me } from '../fixtures/documents';
import { seed, type MockState } from '../store';
import { compute, createDraft, issue, revise } from './commands';
import { checkInvariants } from './invariants';
import { toSatang } from './money';
import { assertBalanced } from './test-helpers';

const VAT = 'co-vat';
let st: MockState;
let n = 0;
beforeEach(() => { st = seed(); });
const sat = (m: string) => toSatang(m);
const get = (id: string) => st.docs.find((d) => d.id === id)!;
const err = (fn: () => unknown): { code?: string } => { try { fn(); } catch (e) { return e as { code?: string }; } return {}; };
const L = (id: string, taxCode: DocLine['taxCode'], unitPrice: string, p: Partial<DocLine> = {}): DocLine => ({ id, description: `รายการ ${id}`, qty: '1', unit: 'งาน', unitPrice, taxCode, ...p });
const draft = (type: 'PB' | 'PCN' | 'PDN', header: Partial<Doc['header']>, lines: DocLine[], company = VAT): Doc =>
  createDraft(st, company, type, { header: { documentDate: '2026-10-14', ...header }, lines }, me, `g-${++n}`);
const draftPb = (header: Partial<Doc['header']>, lines: DocLine[] = [L('a', 'S7', '1000.00')], party = 'pv-01') => draft('PB', { partyId: party, ...header }, lines);
const issueDraft = (d: Doc) => issue(st, d.id, get(d.id).version, me);
const pb = (header: Partial<Doc['header']>, lines?: DocLine[], party?: string): Doc => issueDraft(draftPb(header, lines, party));
const note = (type: 'PCN' | 'PDN', b: Doc, ls: DocLine[], header: Partial<Doc['header']> = {}) =>
  draft(type, { refDocId: b.id, reasonCode: type === 'PCN' ? 'PRICE_REDUCTION' : 'PRICE_INCREASE', ...header }, ls);
const jl = (id: string) => (st.journals.find((j) => j.docId === id)?.preview.entries[0].lines ?? []).map((l) => `${l.accountCode} ${l.debit}/${l.credit}`).sort().join(' | ');
const net = (code: string, ...ids: string[]) => st.journals.filter((j) => ids.includes(j.docId)).reduce((a, j) =>
  a + j.preview.entries.reduce((b, e) => b + e.lines.filter((l) => l.accountCode === code).reduce((c, l) => c + sat(l.debit) - sat(l.credit), 0), 0), 0);

describe('R1-I1 - the claim period is D .. V+6 (D = document month, V = vendor invoice month); an expired window forfeits the VAT, it does not refuse the bill', () => {
  it('bill 2026-10-14, vendor invoice 2026-03-01, no period: forfeited - 1170 0.00, 5170 70.00, AP 1,070.00, no claim period', () => {
    const b = pb({ vendorDocDate: '2026-03-01' });
    expect(get(b.id).header).toMatchObject({ inputVatForfeited: true });
    expect(get(b.id).header.claimPeriod).toBeUndefined();
    expect(jl(b.id)).toBe(['5100 1000.00/0.00', '5170 70.00/0.00', '2110 0.00/1070.00'].sort().join(' | '));
    expect(net('1170', b.id)).toBe(0);
    expect(get(b.id).outstanding).toBe('1070.00');
    assertBalanced(st);
    expect(checkInvariants(st)).toEqual([]);
  });
  it('a period sent on a forfeited bill is not stored; a client-sent flag is ignored both ways', () => {
    const a = pb({ vendorDocDate: '2026-03-01', claimPeriod: '2026-09', inputVatForfeited: false });
    expect(get(a.id).header.inputVatForfeited).toBe(true);
    expect(get(a.id).header.claimPeriod).toBeUndefined();
    const b = pb({ inputVatForfeited: true });
    expect(get(b.id).header.inputVatForfeited).toBeUndefined();
    expect(net('1170', b.id)).toBe(sat('70.00'));
    expect(checkInvariants(st)).toEqual([]);
  });
  it('the preview already posts the forfeited VAT as cost', () => {
    const d = draftPb({ vendorDocDate: '2026-03-01' });
    const c = compute(st, VAT, 'PB', { header: d.header, lines: d.lines });
    expect(c.journal!.entries[0].lines.map((l) => l.accountCode)).toContain('5170');
    expect(c.journal!.entries[0].lines.map((l) => l.accountCode)).not.toContain('1170');
  });
  it('a capex line of a forfeited bill capitalises the VAT into the asset (I3)', () => {
    const b = pb({ vendorDocDate: '2026-03-01' }, [L('a', 'S7', '32000.00', { expenseCategory: 'capex-equipment' })], 'pv-03');
    expect(jl(b.id)).toBe(['1210 34240.00/0.00', '2110 0.00/34240.00'].sort().join(' | '));
  });
  it('bill 2026-10-03, vendor invoice 2026-09-28: default P = 2026-10; 2026-09 (before D) -> 422; 2027-03 ok; 2027-04 -> 422', () => {
    const at = (p?: string) => err(() => issueDraft(draftPb({ documentDate: '2026-10-03', vendorDocDate: '2026-09-28', ...(p ? { claimPeriod: p } : {}) }))).code ?? 'ok';
    expect(at('2026-09')).toBe('pb.claim_period_out_of_range');
    expect(at('2027-03')).toBe('ok');
    expect(at('2027-04')).toBe('pb.claim_period_out_of_range');
    const b = pb({ documentDate: '2026-10-03', vendorDocDate: '2026-09-28' });
    expect(get(b.id).header.claimPeriod).toBe('2026-10');
    expect(get(b.id).header.inputVatForfeited).toBeUndefined();
  });
  it('a bill with no vendor date: D .. D+6 as before (2026-09 refused, 2027-04 ok, 2027-05 refused)', () => {
    const at = (p: string) => err(() => issueDraft(draftPb({ claimPeriod: p }))).code ?? 'ok';
    expect([at('2026-09'), at('2027-04'), at('2027-05')]).toEqual(['pb.claim_period_out_of_range', 'ok', 'pb.claim_period_out_of_range']);
  });
  it('a PDN judges its own V and D', () => {
    const b = pb({}, [L('a', 'S7', '1000.00', { expenseCategory: 'services' })], 'pv-03');
    const d = issueDraft(note('PDN', b, [L('n', 'S7', '100.00', { sourceLineId: 'a' })], { vendorDocDate: '2026-03-05' }));
    expect(get(d.id).header.inputVatForfeited).toBe(true);
    expect(jl(d.id)).toBe(['5120 100.00/0.00', '5170 7.00/0.00', '2110 0.00/107.00'].sort().join(' | '));
    const ok = issueDraft(note('PDN', b, [L('n2', 'S7', '100.00', { sourceLineId: 'a' })], { vendorDocDate: '2026-10-01', claimPeriod: '2026-11' }));
    expect(get(ok.id).header.inputVatForfeited).toBeUndefined();
    expect(net('1170', ok.id)).toBe(sat('7.00'));
    expect(checkInvariants(st)).toEqual([]);
  });
  it('a PCN against a forfeited bill line gives back no 1170 (mirror to cost / asset); the invariants hold, and capex mirrors into the asset', () => {
    const b = pb({ vendorDocDate: '2026-03-01' }, [L('a', 'S7', '1000.00', { expenseCategory: 'services' }), L('k', 'S7', '32000.00', { expenseCategory: 'capex-equipment' })], 'pv-03');
    const c = issueDraft(note('PCN', b, [L('n', 'S7', '1000.00', { sourceLineId: 'a' }), L('m', 'S7', '1000.00', { sourceLineId: 'k' })]));
    expect(get(c.id).header.inputVatForfeited).toBe(true);
    expect(jl(c.id)).toBe(['5120 0.00/1000.00', '5170 0.00/70.00', '1210 0.00/1070.00', '2110 2140.00/0.00'].sort().join(' | '));
    expect(net('1170', b.id, c.id)).toBe(0);
    assertBalanced(st);
    expect(checkInvariants(st)).toEqual([]);
  });
  it('the forfeit flag is re-derived at every revise (date moved into the window), and a bill with a live note keeps its vendor date', () => {
    const b = pb({ vendorDocDate: '2026-03-01' });
    const r = revise(st, b.id, { header: { ...get(b.id).header, vendorDocDate: '2026-09-30' }, lines: get(b.id).lines }, get(b.id).version, 'x', me);
    expect(r.header.inputVatForfeited).toBeUndefined();
    expect(r.header.claimPeriod).toBe('2026-10');
    expect(net('1170', b.id)).toBe(sat('70.00')); // reversal + correction: the VAT is claimed now
    expect(checkInvariants(st)).toEqual([]);
    pb({}); // unrelated
    const c = issueDraft(note('PCN', b, [L('n', 'S7', '100.00', { sourceLineId: 'a' })]));
    expect(c.id).toBeTruthy();
    expect(err(() => revise(st, b.id, { header: { ...get(b.id).header, vendorDocDate: '2026-03-01' }, lines: get(b.id).lines }, get(b.id).version, 'x', me)).code).toBe('pb.has_notes');
  });
  it('invariant teeth: a tampered forfeit flag, and 1170 posted on a forfeited bill, are reported', () => {
    const b = pb({ vendorDocDate: '2026-03-01' });
    expect(checkInvariants(st)).toEqual([]);
    delete get(b.id).header.inputVatForfeited;
    expect(checkInvariants(st).join('\n')).toMatch(new RegExp(`${b.id}: inputVatForfeited`));
  });
});

describe('R1-M1 / M2 - the vendor VAT status is taken at ISSUE; a PDN reads the current status, a PCN inherits the bill\'s', () => {
  const deregister = () => { st.parties.find((p) => p.id === 'pv-03' && p.companyId === VAT)!.vatRegistered = false; };
  it('a PDN after the vendor deregistered is refused; a PCN of the old bill still works', () => {
    const b = pb({}, [L('a', 'S7', '1000.00', { expenseCategory: 'services' })], 'pv-03');
    deregister();
    expect(err(() => issueDraft(note('PDN', b, [L('n', 'S7', '100.00', { sourceLineId: 'a' })]))).code).toBe('pb.vendor_not_vat_registered');
    expect(err(() => issueDraft(note('PCN', b, [L('n', 'S7', '100.00', { sourceLineId: 'a' })]))).code).toBeUndefined();
  });
  it('a draft saved while the vendor was registered is judged on issue day, and carries no snapshot until then', () => {
    const d = draftPb({}, [L('a', 'S7', '100.00')], 'pv-03');
    expect(d.header.vendorVatRegistered).toBeUndefined();
    deregister();
    expect(err(() => issueDraft(d)).code).toBe('pb.vendor_not_vat_registered');
  });
  it('the snapshot is taken at issue and a revise keeps it', () => {
    const b = pb({}, [L('a', 'S7', '1000.00', { expenseCategory: 'services' })], 'pv-03');
    expect(get(b.id).header.vendorVatRegistered).toBe(true);
    deregister();
    const r = revise(st, b.id, { header: { ...get(b.id).header, notes: 'x', vendorVatRegistered: false }, lines: get(b.id).lines }, get(b.id).version, 'x', me);
    expect(r.header.vendorVatRegistered).toBe(true);
  });
});

describe('R1-M3 / M4', () => {
  it('an empty-string vendorDocDate means absent', () => {
    const b = pb({ vendorDocDate: '' });
    expect(get(b.id).header.vendorDocDate).toBeUndefined();
    expect(get(b.id).header.claimPeriod).toBe('2026-10');
  });
  it('an API revise that omits a line\'s category keeps the stored one; an explicit new category changes it', () => {
    const b = pb({}, [L('a', 'S7', '1000.00', { expenseCategory: 'services' })]);
    st.items.find((i) => i.id === 'EXP-07' && i.companyId === VAT)!.expenseCategory = 'entertainment';
    const same = revise(st, b.id, { header: { ...get(b.id).header, notes: 'n' }, lines: [L('a', 'S7', '1000.00', { itemId: 'EXP-07' })] }, get(b.id).version, 'x', me);
    expect(same.lines[0].expenseCategory).toBe('services');
    const moved = revise(st, b.id, { header: get(b.id).header, lines: [L('a', 'S7', '1000.00', { expenseCategory: 'rent' })] }, get(b.id).version, 'x', me);
    expect(moved.lines[0].expenseCategory).toBe('rent');
    assertBalanced(st);
    expect(checkInvariants(st)).toEqual([]);
  });
});
