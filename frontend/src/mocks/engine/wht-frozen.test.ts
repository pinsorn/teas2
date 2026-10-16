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
    expect(get(st, p2).whtFrozen!.bases).toEqual([{ targetId: b, whtTypeCode: 'SVC', base: '0.00', clamped: true, full: true, billBase: '1000.00' }]);
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

const pdn = (st: MockState, bill: string, src: string, price: string) => { const d = createDraft(st, 'co-vat', 'PDN', { header: { documentDate: '2026-10-14', refDocId: bill, reasonCode: 'PRICE_INCREASE' }, lines: [L('c', 'S7', price, { sourceLineId: src })] }, me, `k${n++}`); issue(st, d.id, d.version, me); return d.id; };
const code = (f: () => unknown) => { try { f(); return 'OK'; } catch (e) { return (e as { code?: string }).code; } };

describe('round 2: a paid bill is frozen (R1-I1 a), 11b compares with the base stored at pay-up (b)', () => {
  it('X5: paid up by one voucher, then a PCN of 1,000 on the service and a PDN of 1,000 on the goods: invariants stay []', () => {
    const st = buildSeedState();
    const b = pb(st, [svc('s', '10000.00'), goods('g', '10000.00')]);
    const p = pv(st, b, '21400.00');
    expect(get(st, p).whtFrozen!.bases).toEqual([{ targetId: b, whtTypeCode: 'SVC', base: '10000.00', full: true, billBase: '10000.00' }]);
    pcn(st, b, 's', '1000.00');
    pdn(st, b, 'g', '1000.00');
    expect([get(st, b).outstanding, get(st, b).status]).toEqual(['0.00', 'settled']);
    expect(checkInvariants(st)).toEqual([]);
  });
  it('11b still catches a stored base that does not add up to the base stored at pay-up (can fail)', () => {
    const st = buildSeedState();
    const b = pb(st, [svc('s', '10000.00')]);
    const p = pv(st, b, '10700.00');
    get(st, p).whtFrozen!.bases[0].base = '9000.00';
    expect(checkInvariants(st).join(' | ')).toContain('paid up but its vouchers withheld on 9000.00 of SVC');
  });
  it('X6: a bill a live voucher settles refuses a change of lines / WHT type with pb.settled_locked; notes stay editable; cancelling the voucher frees it', () => {
    const st = buildSeedState();
    const b = pb(st, [svc('s', '10000.00')]);
    const p = pv(st, b, '10700.00');
    const d = get(st, b);
    expect(code(() => revise(st, b, { header: d.header, lines: [{ ...d.lines[0], whtTypeCode: 'RENT' }] }, d.version, 'x', me))).toBe('pb.settled_locked');
    expect(code(() => revise(st, b, { header: { ...d.header, documentDate: '2026-10-13' }, lines: d.lines }, d.version, 'x', me))).toBe('pb.settled_locked');
    expect(code(() => revise(st, b, { header: { ...d.header, notes: 'ok' }, lines: d.lines }, d.version, 'x', me))).toBe('OK');
    cancel(st, p, get(st, p).version, 'OTHER', 'x', me);
    const d2 = get(st, b);
    expect(code(() => revise(st, b, { header: d2.header, lines: [{ ...d2.lines[0], whtTypeCode: 'RENT' }] }, d2.version, 'x', me))).toBe('OK');
    expect(checkInvariants(st)).toEqual([]);
  });
  it('X1: PV1 revised down after PV2 paid the bill up, PV3 pays the rest: total WHT is 300.00 and the invariants hold', () => {
    const st = buildSeedState();
    const b = pb(st, [svc('s', '10000.00'), goods('g', '10000.00')]);
    const p1 = pv(st, b, '10700.00'), p2 = pv(st, b, '10700.00');
    const d = get(st, p1);
    revise(st, p1, { header: d.header, lines: [], allocations: [{ targetId: b, targetType: 'PB', amount: '5000.00' }] }, d.version, 'x', me);
    expect(checkInvariants(st)).toEqual([]); // reopened: 11b does not apply
    const p3 = pv(st, b, get(st, b).outstanding!);
    expect(sat(wht(st, p1)) + sat(wht(st, p2)) + sat(wht(st, p3))).toBe(30000);
    expect(checkInvariants(st)).toEqual([]);
  });
  it('M2: an explicit null clears a bill line stored WHT type (unpaid bill); omitted keeps it', () => {
    const st = buildSeedState();
    const b = pb(st, [svc('s', '10000.00')]);
    const d = get(st, b);
    const { whtTypeCode: _w, ...bare } = d.lines[0]; void _w;
    revise(st, b, { header: d.header, lines: [bare] }, d.version, 'x', me);
    expect(get(st, b).lines[0].whtTypeCode).toBe('SVC');
    const d2 = get(st, b);
    revise(st, b, { header: d2.header, lines: [{ ...bare, whtTypeCode: null as unknown as undefined }] }, d2.version, 'x', me);
    expect(get(st, b).lines[0].whtTypeCode ?? '').toBe('');
  });
  it('M2: a cleared type is not refilled from the item master', () => {
    const st = buildSeedState();
    const b = pb(st, [L('s', 'S7', '10000.00', { itemId: 'EXP-01', expenseCategory: 'rent' })]);
    expect(get(st, b).lines[0].whtTypeCode).toBe('RENT');
    const d = get(st, b);
    revise(st, b, { header: d.header, lines: [{ ...d.lines[0], whtTypeCode: null as unknown as undefined }] }, d.version, 'x', me);
    expect(get(st, b).lines[0].whtTypeCode ?? '').toBe('');
    const d2 = get(st, b);
    revise(st, b, { header: { ...d2.header, notes: 'n' }, lines: d2.lines.map(({ whtTypeCode: _w, ...r }) => (void _w, r)) }, d2.version, 'x', me);
    expect(get(st, b).lines[0].whtTypeCode ?? '').toBe('');
  });

  const holders = (st: MockState, bill: string) => st.docs.filter((d) => d.type === 'PV' && d.status === 'issued' && d.whtFrozen?.bases.some((x) => x.targetId === bill && x.full)).map((d) => d.id);
  it('exactly one paid-up record: it moves to the PV that pays the bill up again, and a reopening clears it (no stale record can hide a tampered base)', () => {
    const st = buildSeedState();
    const b = pb(st, [svc('s', '10000.00')]);
    const p1 = pv(st, b, '5350.00'), p2 = pv(st, b, '5350.00');
    expect(holders(st, b)).toEqual([p2]);
    const d = get(st, p1);
    revise(st, p1, { header: d.header, lines: [], allocations: [{ targetId: b, targetType: 'PB', amount: '1000.00' }] }, d.version, 'x', me); // reopens the bill
    expect(holders(st, b)).toEqual([]);
    const p3 = pv(st, b, get(st, b).outstanding!);
    expect(holders(st, b)).toEqual([p3]);
    expect(checkInvariants(st)).toEqual([]);
    // tamper the holder: a stale record elsewhere cannot excuse it
    const bases = get(st, p3).whtFrozen!.bases[0];
    const good = bases.base;
    bases.base = '9000.00';
    expect(checkInvariants(st).join(' | ')).toContain('paid up but its vouchers withheld');
    bases.base = good;
    // a second record is itself a violation
    get(st, p2).whtFrozen!.bases[0].full = true; get(st, p2).whtFrozen!.bases[0].billBase = '10000.00';
    expect(checkInvariants(st).join(' | ')).toContain('two paid-up records');
  });
  it('cancelling an earlier voucher reopens the bill and clears the record; cancelling the holder leaves none', () => {
    const st = buildSeedState();
    const b = pb(st, [svc('s', '10000.00')]);
    const p1 = pv(st, b, '5350.00'), p2 = pv(st, b, '5350.00');
    cancel(st, p1, get(st, p1).version, 'OTHER', 'x', me);
    expect(holders(st, b)).toEqual([]);
    expect(checkInvariants(st)).toEqual([]);
    const p3 = pv(st, b, get(st, b).outstanding!);
    cancel(st, p3, get(st, p3).version, 'OTHER', 'x', me);
    expect(holders(st, b)).toEqual([]);
    expect(p2).toBeDefined();
    expect(checkInvariants(st)).toEqual([]);
  });
  it('clamp: the exact rule is Σ bases = max(B_paidUp, Σ bases of the other vouchers) - a tampered clamped holder is reported', () => {
    const st = buildSeedState();
    const b = pb(st, [svc('s', '10000.00'), goods('g', '10000.00')]);
    pv(st, b, '10700.00');
    pcn(st, b, 's', '9000.00');
    const p2 = pv(st, b, get(st, b).outstanding!);
    expect(checkInvariants(st)).toEqual([]);
    get(st, p2).whtFrozen!.bases[0].base = '1.00';
    expect(checkInvariants(st).join(' | ')).toContain('paid up but its vouchers withheld on 5001.00 of SVC');
  });
});
