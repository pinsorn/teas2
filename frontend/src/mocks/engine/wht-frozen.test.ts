import { describe, expect, it } from 'vitest';
import type { DocLine } from '@/domain/types';
import { USER as me } from '../fixtures/documents';
import { buildSeedState, type MockState } from '../store';
import { cancel, createDraft, issue, revise } from './commands';
import { checkInvariants } from './invariants';

/** P3 fix round 1: a voucher's WHT is fixed when it is issued (C1) and cumulative per bill (I1). Every scenario drives the real commands. */
const L = (id: string, taxCode: DocLine['taxCode'], unitPrice: string, p: Partial<DocLine> = {}): DocLine => ({ id, description: `x ${id}`, qty: '1', unit: 'u', unitPrice, taxCode, ...p });
const svc = (id: string, price: string) => L(id, 'S7', price, { expenseCategory: 'services', whtTypeCode: 'SVC' });
const goods = (id: string, price: string) => L(id, 'S7', price, { expenseCategory: 'supplies' });
const get = (st: MockState, id: string) => st.docs.find((d) => d.id === id)!;
let n = 0;
const pb = (st: MockState, lines: DocLine[]) => { const d = createDraft(st, 'co-vat', 'PB', { header: { partyId: 'pv-03', documentDate: '2026-10-14' }, lines }, me, `k${n++}`); issue(st, d.id, d.version, me); return d.id; };
const pv = (st: MockState, bill: string, amount: string) => { const d = createDraft(st, 'co-vat', 'PV', { header: { partyId: 'pv-03', documentDate: '2026-10-14' }, lines: [], allocations: [{ targetId: bill, targetType: 'PB', amount }] }, me, `k${n++}`); issue(st, d.id, d.version, me); return d.id; };
const pcn = (st: MockState, bill: string, src: string, price: string) => { const d = createDraft(st, 'co-vat', 'PCN', { header: { documentDate: '2026-10-14', refDocId: bill, reasonCode: 'DISCOUNT' }, lines: [L('c', 'S7', price, { sourceLineId: src })] }, me, `k${n++}`); issue(st, d.id, d.version, me); return d.id; };
const wtIds = (st: MockState, pvId: string) => st.links.filter((l) => l.active && l.kind === 'issues' && l.from === pvId).map((l) => l.to).sort();
const wht = (st: MockState, id: string) => get(st, id).totals.wht;
const sat = (m?: string) => Math.round(Number(m ?? '0') * 100);
/** Σ stored bases of one WHT type over the live vouchers of a bill. */
const baseSum = (st: MockState, bill: string, code = 'SVC') => st.docs.filter((d) => d.type === 'PV' && d.status === 'issued').flatMap((d) => d.whtFrozen?.bases ?? []).filter((b) => b.targetId === bill && b.whtTypeCode === code).reduce((a, b) => a + sat(b.base), 0);

describe('C1: the WHT of an issued voucher does not move with later documents', () => {
  it('W1: a PCN on the goods line after PV1 leaves PV1, its cash and its certificate alone; a notes-only revise keeps them', () => {
    const st = buildSeedState();
    const b = pb(st, [svc('s', '10000.00'), goods('g', '10000.00')]);
    const p1 = pv(st, b, '10700.00');
    expect([wht(st, p1), get(st, p1).totals.cash]).toEqual(['150.00', '10550.00']);
    const wts = wtIds(st, p1);
    pcn(st, b, 'g', '10000.00');
    expect(checkInvariants(st)).toEqual([]);
    const d = get(st, p1);
    revise(st, p1, { header: { ...d.header, notes: 'n' }, lines: d.lines, allocations: d.allocations }, d.version, 'x', me);
    expect([wht(st, p1), get(st, p1).totals.cash]).toEqual(['150.00', '10550.00']);
    expect(wtIds(st, p1)).toEqual(wts);
    expect(wts.map((w) => get(st, w).status)).toEqual(['issued']);
    expect(checkInvariants(st)).toEqual([]);
    const live = st.journals.find((j) => j.docId === p1)!.preview.entries.at(-1)!; // the latest posting still pays 10,550.00 and withholds 150.00
    expect(live.lines.filter((l) => l.accountCode === '1121').map((l) => l.credit)).toEqual(['10550.00']);
  });
  it('W6: cancelling a PCN after the payment leaves PV1 alone', () => {
    const st = buildSeedState();
    const b = pb(st, [svc('s', '10000.00'), goods('g', '10000.00')]);
    const c = pcn(st, b, 'g', '10000.00');
    const p1 = pv(st, b, '5350.00');
    expect(wht(st, p1)).toBe('150.00');
    cancel(st, c, get(st, c).version, 'OTHER', 'x', me);
    expect(wht(st, p1)).toBe('150.00');
    expect(checkInvariants(st)).toEqual([]);
  });
  it("W4: editing an item's WHT type after issue leaves the seed consistent (the bill line stored its type)", () => {
    const st = buildSeedState();
    expect(checkInvariants(st)).toEqual([]);
    st.items.find((i) => i.id === 'EXP-01' && i.companyId === 'co-vat')!.whtTypeCode = 'SVC';
    expect(checkInvariants(st)).toEqual([]);
  });
  it("a bill line that names only an item stores that item's WHT type at issue", () => {
    const st = buildSeedState();
    expect(get(st, 'pb-1').lines[0].whtTypeCode).toBe('RENT');
  });
});

describe('I1: cumulative WHT per bill', () => {
  it('W2: PV1 150.00, a PCN of 4,000.00 on the service line, PV2 pays the rest: total WHT is 3 % of the 6,000.00 service = 180.00', () => {
    const st = buildSeedState();
    const b = pb(st, [svc('s', '10000.00'), goods('g', '10000.00')]);
    const p1 = pv(st, b, '10700.00');
    pcn(st, b, 's', '4000.00');
    const p2 = pv(st, b, get(st, b).outstanding!);
    expect(sat(wht(st, p1)) + sat(wht(st, p2))).toBe(18000);
    expect(baseSum(st, b)).toBe(600000);
    expect(checkInvariants(st)).toEqual([]);
  });
  it.each([2, 3, 7])('W3: one bill paid in %i parts withholds on exactly the bill base (tax within 1 satang a voucher of one payment)', (parts) => {
    const st = buildSeedState();
    const b = pb(st, [svc('s', '33333.33'), goods('g', '1111.11')]);
    const total = sat(get(st, b).totals.total);
    let left = total, sum = 0;
    for (let i = 0; i < parts; i++) { const amt = i === parts - 1 ? left : Math.floor(total / parts); left -= amt; sum += sat(wht(st, pv(st, b, (amt / 100).toFixed(2)))); }
    const st2 = buildSeedState();
    const b2 = pb(st2, [svc('s', '33333.33'), goods('g', '1111.11')]);
    expect(Math.abs(sum - sat(wht(st2, pv(st2, b2, get(st2, b2).totals.total))))).toBeLessThanOrEqual(parts); // each voucher's tax is rounded on its own base: <= 1 satang a voucher; the BASES are exact
    expect(baseSum(st, b)).toBe(3333333);
    expect(checkInvariants(st)).toEqual([]);
  });
  it('cancelling the middle voucher and paying again is still exact', () => {
    const st = buildSeedState();
    const b = pb(st, [svc('s', '33333.33'), goods('g', '1111.11')]);
    const total = sat(get(st, b).totals.total), third = Math.floor(total / 3);
    pv(st, b, (third / 100).toFixed(2));
    const p2 = pv(st, b, (third / 100).toFixed(2));
    cancel(st, p2, get(st, p2).version, 'OTHER', 'x', me);
    pv(st, b, ((total - third) / 100).toFixed(2));
    expect(get(st, b).status).toBe('settled');
    expect(baseSum(st, b)).toBe(3333333);
    expect(checkInvariants(st)).toEqual([]);
  });
  it('a credit that makes the earlier withholding too high is not refunded: the later base is clamped to 0 and the invariants still hold', () => {
    const st = buildSeedState();
    const b = pb(st, [svc('s', '10000.00'), goods('g', '10000.00')]);
    pv(st, b, '10700.00'); // base 5,000.00
    pcn(st, b, 's', '9000.00'); // the service is now 1,000.00
    const p2 = pv(st, b, get(st, b).outstanding!);
    expect(wht(st, p2)).toBe('0.00');
    expect(get(st, p2).whtFrozen!.bases).toEqual([{ targetId: b, whtTypeCode: 'SVC', base: '0.00', clamped: true, full: true }]);
    expect(wtIds(st, p2)).toEqual([]);
    expect(checkInvariants(st)).toEqual([]);
  });
  it('a revise that changes the amount recomputes against the other live vouchers', () => {
    const st = buildSeedState();
    const b = pb(st, [svc('s', '10000.00'), goods('g', '10000.00')]);
    pv(st, b, '3000.00');
    const p2 = pv(st, b, '3000.00');
    const d = get(st, p2);
    revise(st, p2, { header: d.header, lines: [], allocations: [{ targetId: b, targetType: 'PB', amount: '18400.00' }] }, d.version, 'x', me);
    expect(baseSum(st, b)).toBe(1000000);
    expect(checkInvariants(st)).toEqual([]);
  });
  it('invariants report a stored base that no longer adds up to the paid-up bill, and a live voucher with no stored figures (can fail)', () => {
    const st = buildSeedState();
    const base = get(st, 'pv-pay1').whtFrozen!.bases[0];
    base.base = '1.00';
    expect(checkInvariants(st).join(' | ')).toContain('pb-1: paid up but its vouchers withheld on 1.00 of RENT');
    base.base = '22500.00';
    delete get(st, 'pv-pay1').whtFrozen;
    expect(checkInvariants(st).join(' | ')).toContain('pv-pay1: a live voucher without its stored withholding figures');
  });
});
