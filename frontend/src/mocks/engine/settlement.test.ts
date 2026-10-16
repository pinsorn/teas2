import { describe, expect, it } from 'vitest';
import type { Allocation, DocHeader, DocLine } from '@/domain/types';
import { USER } from '../fixtures/documents';
import { fixtureIds } from '../fixtures/ids';
import { buildSeedState, type MockState } from '../store';
import { cancel, compute, createDraft, issue, revise } from './commands';
import { correctionPlan, executePlan } from './corrections';
import { checkInvariants } from './invariants';
import { ledgerFor } from './ledger';
import { toSatang } from './money';
import { assertBalanced } from './test-helpers';

const out = (st: MockState, id: string) => toSatang(st.docs.find((d) => d.id === id)!.outstanding!);
const row = (st: MockState, docId: string, code: string) => st.journals.find((j) => j.docId === docId)!.preview.entries[0].lines.find((l) => l.accountCode === code);
const line = (p: Partial<DocLine> = {}): DocLine => ({ id: 'l1', description: 'ออกแบบ', qty: '1', unit: 'งาน', unitPrice: '1000.00', taxCode: 'S7', ...p });
const hdr = (partyId: string, p: Partial<DocHeader> = {}): DocHeader => ({ partyId, documentDate: '2026-10-14', ...p });

/** The multi-target vector: pc-01 pays 1,000.00 (customer withheld 30.00 SVC) on target A and 500.00 on target B. */
function multiRc(st: MockState, key = 'k1') {
  const ids = fixtureIds(st);
  const rc = createDraft(st, 'co-vat', 'RC', { header: hdr('pc-01', { bankAccountId: 'ba-kbank' }), lines: [], allocations: [
    { targetId: ids.rcTargetsA, targetType: 'TI', amount: '1000.00', wht: '30.00', whtTypeCode: 'SVC' },
    { targetId: ids.rcTargetsB, targetType: 'TI', amount: '500.00' }] }, USER, key);
  return { ids, rc };
}

describe('multi-target receipt (§5.11, §7.11)', () => {
  it('one RC settles two TIs partly with WHT; cash + WHT receivable = Σ allocations; each outstanding follows the formula', () => {
    const st = buildSeedState();
    const { ids, rc } = multiRc(st);
    const before = [out(st, ids.rcTargetsA), out(st, ids.rcTargetsB)];
    const done = issue(st, rc.id, rc.version, USER);
    expect(done.totals.total).toBe('1500.00');
    expect(done.totals.wht).toBe('30.00');
    expect(done.totals.cash).toBe('1470.00');
    expect([out(st, ids.rcTargetsA), out(st, ids.rcTargetsB)]).toEqual([before[0] - 100000, before[1] - 50000]);
    // one settles link per allocation, each with its own amount and WHT
    const links = st.links.filter((l) => l.from === done.id && l.kind === 'settles' && l.active);
    expect(links.map((l) => [l.to, l.amount, l.wht])).toEqual([[ids.rcTargetsA, '1000.00', '30.00'], [ids.rcTargetsB, '500.00', undefined]]);
    // the journal: bank 1121 (the header's account), WHT receivable 1180, AR 1130
    expect([row(st, done.id, '1121')?.debit, row(st, done.id, '1180')?.debit, row(st, done.id, '1130')?.credit]).toEqual(['1470.00', '30.00', '1500.00']);
    expect(done.allocations?.map((a) => a.targetNumber)).toEqual(st.docs.filter((d) => [ids.rcTargetsA, ids.rcTargetsB].includes(d.id)).map((d) => d.number));
    assertBalanced(st);
    expect(checkInvariants(st)).toEqual([]);
  });

  it('refuses an allocation above the outstanding (settle.over_allocation), naming the target and its outstanding, and writes nothing', () => {
    const st = buildSeedState();
    const ids = fixtureIds(st);
    const a = st.docs.find((d) => d.id === ids.rcTargetsA)!;
    const rc = createDraft(st, 'co-vat', 'RC', { header: hdr('pc-01'), lines: [], allocations: [{ targetId: a.id, targetType: 'TI', amount: '999999.00' }] }, USER, 'over');
    const snap = JSON.stringify([st.links, st.series, st.journals.length, out(st, a.id)]);
    expect(() => issue(st, rc.id, rc.version, USER)).toThrow(new RegExp(`settle.over_allocation.*${a.number}.*${a.outstanding}`));
    expect(JSON.stringify([st.links, st.series, st.journals.length, out(st, a.id)])).toBe(snap);
    expect(st.docs.find((d) => d.id === rc.id)!.status).toBe('draft');
  });

  it('a second receipt for the same invoice is refused once the first took the outstanding (real issue, not a seeded state)', () => {
    const st = buildSeedState();
    const a = st.docs.find((d) => d.id === fixtureIds(st).rcTargetsA)!;
    const mk = (k: string) => createDraft(st, 'co-vat', 'RC', { header: hdr('pc-01'), lines: [], allocations: [{ targetId: a.id, targetType: 'TI', amount: a.outstanding! }] }, USER, k);
    const r1 = mk('x1'), r2 = mk('x2');
    issue(st, r1.id, r1.version, USER);
    expect(out(st, a.id)).toBe(0);
    expect(st.docs.find((d) => d.id === a.id)!.status).toBe('settled');
    expect(() => issue(st, r2.id, r2.version, USER)).toThrow(/settle.over_allocation/);
  });

  it('refuses Σ wht > Σ amount (rc.wht_exceeds_amount)', () => {
    const st = buildSeedState();
    const a = fixtureIds(st).rcTargetsA;
    const rc = createDraft(st, 'co-vat', 'RC', { header: hdr('pc-01'), lines: [], allocations: [{ targetId: a, targetType: 'TI', amount: '100.00', wht: '100.01' }] }, USER, 'wx');
    expect(() => issue(st, rc.id, rc.version, USER)).toThrow(/rc.wht_exceeds_amount/);
    const ok = createDraft(st, 'co-vat', 'RC', { header: hdr('pc-01'), lines: [], allocations: [{ targetId: a, targetType: 'TI', amount: '100.00', wht: '100.00' }] }, USER, 'wy');
    expect(issue(st, ok.id, ok.version, USER).totals.cash).toBe('0.00'); // withholding the whole amount is the boundary that is allowed
  });

  it('compute reports an invalid allocation as missing (the editor can disable the action) without throwing', () => {
    const st = buildSeedState();
    const a = fixtureIds(st).rcTargetsA;
    const r = compute(st, 'co-vat', 'RC', { header: hdr('pc-01'), lines: [], allocations: [{ targetId: a, targetType: 'TI', amount: '99999999.00' }] });
    expect(r.missing.map((m) => m.field)).toContain('allocations');
    expect(r.missing.map((m) => m.message).join()).toMatch(/เกินยอดค้างชำระ/);
    const empty = compute(st, 'co-vat', 'RC', { header: hdr('pc-01'), lines: [] });
    expect(empty.missing.map((m) => m.field)).toEqual(['allocations']);
  });

  it('cancelling the RC restores both outstanding amounts exactly', () => {
    const st = buildSeedState();
    const { ids, rc } = multiRc(st);
    const before = [out(st, ids.rcTargetsA), out(st, ids.rcTargetsB)];
    const done = issue(st, rc.id, rc.version, USER);
    cancel(st, done.id, done.version, 'OTHER', 'ทดสอบ', USER);
    expect([out(st, ids.rcTargetsA), out(st, ids.rcTargetsB)]).toEqual(before);
    expect(st.docs.find((d) => d.id === ids.rcTargetsA)!.status).toBe('issued');
    expect(st.links.filter((l) => l.from === done.id && l.active)).toEqual([]);
    assertBalanced(st);
  });

  it('correcting TI a (customer) re-creates BOTH settlements: a′ gets 1000 with its WHT, b keeps 500 (brief: fixed multi-invoice settlement)', () => {
    const st = buildSeedState();
    const { ids, rc } = multiRc(st);
    const done = issue(st, rc.id, rc.version, USER);
    const a = st.docs.find((d) => d.id === ids.rcTargetsA)!;
    const bAfterRc = out(st, ids.rcTargetsB);
    const plan = correctionPlan(st, a.id, { header: { ...a.header, partyId: 'pc-02' }, lines: a.lines }, 'accountant');
    expect(plan.steps.map((s) => [s.action, s.docType])).toEqual([['cancel', 'RC'], ['reissue', 'TI'], ['reissue', 'RC']]);
    executePlan(st, plan.planId, plan.planHash, USER, 'accountant');
    const a2 = st.docs.find((d) => d.replacesId === a.id)!;
    const newRc = st.docs.find((d) => d.replacesId === done.id)!;
    const links = st.links.filter((l) => l.from === newRc.id && l.kind === 'settles' && l.active);
    expect(links.map((l) => [l.to, l.amount, l.wht])).toEqual([[a2.id, '1000.00', '30.00'], [ids.rcTargetsB, '500.00', undefined]]);
    expect(out(st, ids.rcTargetsB)).toBe(bAfterRc);
    expect(out(st, a2.id)).toBe(toSatang(a2.totals.total) - 100000);
    expect(links.reduce((n, l) => n + toSatang(l.amount!), 0)).toBe(toSatang(newRc.totals.total));
    expect(newRc.totals).toMatchObject({ total: '1500.00', wht: '30.00', cash: '1470.00' });
    expect(newRc.allocations?.[0]).toMatchObject({ whtTypeCode: 'SVC', targetId: a2.id });
    expect(st.docs.find((d) => d.id === done.id)!.status).toBe('replaced');
    assertBalanced(st);
  });

  it('correcting the receipt itself to a total above a target outstanding is refused (settle.over_allocation) and rolls the whole plan back', () => {
    const st = buildSeedState();
    const { ids, rc } = multiRc(st);
    const done = issue(st, rc.id, rc.version, USER);
    const stored = st.docs.find((d) => d.id === done.id)!;
    const snap = JSON.stringify(st.docs.map((d) => [d.id, d.status, d.outstanding]));
    const bigger = stored.allocations!.map((x) => (x.targetId === ids.rcTargetsA ? { ...x, amount: '99999999.00' } : x));
    // refused when the plan is asked for (S4 fix round 1, M4): a plan that cannot execute is never shown
    expect(() => correctionPlan(st, done.id, { header: stored.header, lines: [], allocations: bigger }, 'accountant')).toThrow(/settle.over_allocation/);
    expect(JSON.stringify(st.docs.map((d) => [d.id, d.status, d.outstanding]))).toBe(snap);
  });
});

describe('deposit remainder and cash bill', () => {
  it('an unallocated remainder becomes a customer deposit (Cr 2140) and is not an AR credit', () => {
    const st = buildSeedState();
    const a = fixtureIds(st).rcTargetsA;
    const rc = createDraft(st, 'co-vat', 'RC', { header: hdr('pc-01', { depositAmount: '5000.00' }), lines: [], allocations: [{ targetId: a, targetType: 'TI', amount: '1000.00' }] }, USER, 'dep');
    const r = compute(st, 'co-vat', 'RC', { header: rc.header, lines: [], allocations: rc.allocations });
    expect(r.allocation).toMatchObject({ allocated: '1000.00', unallocated: '5000.00' });
    const done = issue(st, rc.id, rc.version, USER);
    expect([done.totals.total, done.totals.cash]).toEqual(['6000.00', '6000.00']);
    expect([row(st, done.id, '2140')?.credit, row(st, done.id, '1130')?.credit, row(st, done.id, '1121')?.debit]).toEqual(['5000.00', '1000.00', '6000.00']);
    assertBalanced(st);
  });
  it('a deposit-only receipt (no allocation) posts Dr bank / Cr 2140 and touches no invoice', () => {
    const st = buildSeedState();
    const before = JSON.stringify(st.docs.filter((d) => d.type === 'TI').map((d) => d.outstanding));
    const rc = createDraft(st, 'co-vat', 'RC', { header: hdr('pc-08', { depositAmount: '5000.00' }), lines: [] }, USER, 'dep2');
    const done = issue(st, rc.id, rc.version, USER);
    expect([row(st, done.id, '2140')?.credit, row(st, done.id, '1130')]).toEqual(['5000.00', undefined]);
    expect(JSON.stringify(st.docs.filter((d) => d.type === 'TI').map((d) => d.outstanding))).toBe(before);
    assertBalanced(st);
  });
  it('a non-VAT cash bill: the lines are the receipt (Dr bank / Cr revenue), no AR', () => {
    const st = buildSeedState();
    const rc = createDraft(st, 'co-nonvat', 'RC', { header: hdr('nc-01'), lines: [line({ id: 'a', unitPrice: '1000.00', taxCode: 'EX' }), line({ id: 'b', unitPrice: '500.00', taxCode: 'EX' })] }, USER, 'cb');
    expect(rc.header).toMatchObject({ bankAccountId: 'nba-kbank', paymentMethod: 'transfer' });
    const done = issue(st, rc.id, rc.version, USER);
    expect([done.totals.total, done.totals.cash]).toEqual(['1500.00', '1500.00']);
    expect([row(st, done.id, '1121')?.debit, row(st, done.id, '4100')?.credit, row(st, done.id, '1130')]).toEqual(['1500.00', '1500.00', undefined]);
    assertBalanced(st);
  });
});

describe('allocation rules', () => {
  const attempt = (st: MockState, allocations: Allocation[], partyId = 'pc-01', key = 'r') => {
    const rc = createDraft(st, 'co-vat', 'RC', { header: hdr(partyId), lines: [], allocations }, USER, key);
    return () => issue(st, rc.id, rc.version, USER);
  };
  it('refuses a target of another party, a duplicate target, a cancelled target, a wrong type, and an unknown target', () => {
    const st = buildSeedState();
    const ids = fixtureIds(st);
    const other = st.docs.find((d) => d.type === 'TI' && d.status === 'issued' && d.header.partyId !== 'pc-01' && d.outstanding === d.totals.total)!;
    expect(attempt(st, [{ targetId: other.id, targetType: 'TI', amount: '1.00' }], 'pc-01', 'p1')).toThrow(/settle.party_mismatch/);
    expect(attempt(st, [{ targetId: ids.rcTargetsA, targetType: 'TI', amount: '1.00' }, { targetId: ids.rcTargetsA, targetType: 'TI', amount: '2.00' }], 'pc-01', 'p2')).toThrow(/settle.duplicate_target/);
    const replaced = st.docs.find((d) => d.status === 'replaced' && d.type === 'TI' && d.header.partyId === 'pc-01') ?? st.docs.find((d) => d.status === 'replaced' && d.type === 'TI')!;
    expect(attempt(st, [{ targetId: replaced.id, targetType: 'TI', amount: '1.00' }], replaced.header.partyId!, 'p3')).toThrow(/settle.target_not_open/);
    const qt = st.docs.find((d) => d.type === 'QT' && d.status === 'issued')!;
    expect(attempt(st, [{ targetId: qt.id, targetType: 'QT', amount: '1.00' }], qt.header.partyId!, 'p4')).toThrow(/settle.wrong_type/);
    expect(attempt(st, [{ targetId: 'nope', targetType: 'TI', amount: '1.00' }], 'pc-01', 'p5')).toThrow(/settle.target_not_found/);
    expect(attempt(st, [{ targetId: ids.rcTargetsA, targetType: 'TI', amount: '0.00' }], 'pc-01', 'p6')).toThrow(/settle.invalid_amount/);
  });
  it('refuses a target of another company (a non-VAT invoice cannot be settled by a VAT company receipt)', () => {
    const st = buildSeedState();
    const iv = createDraft(st, 'co-nonvat', 'IV', { header: hdr('nc-01'), lines: [line({ taxCode: 'EX' })] }, USER, 'iv-other');
    const issued = issue(st, iv.id, iv.version, USER);
    expect(attempt(st, [{ targetId: issued.id, targetType: 'IV', amount: '1.00' }], 'pc-01', 'c1')).toThrow(/settle.target_not_found/);
    // and inside its own company the same invoice IS settled by an RC (IV is in the RC settles list)
    const own = createDraft(st, 'co-nonvat', 'RC', { header: hdr('nc-01'), lines: [], allocations: [{ targetId: issued.id, targetType: 'IV', amount: '400.00' }] }, USER, 'c2');
    issue(st, own.id, own.version, USER);
    expect(out(st, issued.id)).toBe(60000);
    expect(st.docs.find((d) => d.id === issued.id)!.status).toBe('partly_settled');
    assertBalanced(st);
  });
  it('a TI cannot carry allocations; garbage money in a draft is a 422, not a crash', () => {
    const st = buildSeedState();
    expect(() => createDraft(st, 'co-vat', 'TI', { header: hdr('pc-01'), lines: [line()], allocations: [{ targetId: 'x', targetType: 'TI', amount: '1.00' }] }, USER, 'ti')).toThrow(/settle.not_allowed/);
    expect(() => createDraft(st, 'co-vat', 'RC', { header: hdr('pc-01'), lines: [], allocations: [{ targetId: 'x', targetType: 'TI', amount: 'abc' }] }, USER, 'bad')).toThrow(/settle.invalid_amount/);
  });
  it('an RC with nothing to receive is incomplete', () => {
    const st = buildSeedState();
    const rc = createDraft(st, 'co-vat', 'RC', { header: hdr('pc-01'), lines: [] }, USER, 'empty');
    expect(() => issue(st, rc.id, rc.version, USER)).toThrow(/doc.incomplete/);
  });
  it('header defaults: transfer, the company default bank account, deduct (PV only)', () => {
    const st = buildSeedState();
    const rc = createDraft(st, 'co-vat', 'RC', { header: hdr('pc-01'), lines: [] }, USER, 'h1');
    const pv = createDraft(st, 'co-vat', 'PV', { header: hdr('pv-01'), lines: [line({ taxCode: 'EX' })] }, USER, 'h2');
    expect(rc.header).toMatchObject({ paymentMethod: 'transfer', bankAccountId: 'ba-kbank' });
    expect(rc.header.whtMode).toBeUndefined();
    expect(pv.header).toMatchObject({ paymentMethod: 'transfer', bankAccountId: 'ba-kbank', whtMode: 'deduct' });
    const own = createDraft(st, 'co-vat', 'PV', { header: hdr('pv-01', { bankAccountId: 'ba-scb', whtMode: 'grossup_once', paymentMethod: 'cheque' }), lines: [line({ taxCode: 'EX' })] }, USER, 'h3');
    expect(own.header).toMatchObject({ paymentMethod: 'cheque', bankAccountId: 'ba-scb', whtMode: 'grossup_once' });
  });
  it('suggested WHT = round(service net x rate x amount / target total), per the target service lines; goods carry none', () => {
    const st = buildSeedState();
    const ti = createDraft(st, 'co-vat', 'TI', { header: hdr('pc-01'), lines: [line({ id: 's', itemId: 'SV-01', unitPrice: '60000.00' }), line({ id: 'g', itemId: 'GD-01', qty: '10', unitPrice: '450.00' })] }, USER, 'sg');
    const issued = issue(st, ti.id, ti.version, USER); // net 60,000 + 4,500; VAT 4,515; total 69,015.00
    expect(issued.totals.total).toBe('69015.00');
    const sug = (amount: string) => compute(st, 'co-vat', 'RC', { header: hdr('pc-01'), lines: [], allocations: [{ targetId: ti.id, targetType: 'TI', amount }] }).allocation!.suggestedWht;
    expect(sug('69015.00')).toEqual([{ targetId: ti.id, wht: '1800.00', whtTypeCode: 'SVC' }]); // 60,000.00 x 3 %
    expect(sug('34507.50')).toEqual([{ targetId: ti.id, wht: '900.00', whtTypeCode: 'SVC' }]); // half paid: 3,450,750 x 6,000,000 x 300 / (6,901,500 x 10,000) = 90,000 satang
  });
});

describe('payment voucher settles PB (D-17), AP is the subledger of PB', () => {
  const pb = (st: MockState, key: string, unitPrice = '10000.00') => {
    const d = createDraft(st, 'co-vat', 'PB', { header: hdr('pv-01'), lines: [line({ unitPrice, itemId: undefined })] }, USER, key);
    return issue(st, d.id, d.version, USER);
  };
  it('a PV pays two bills in part: AP debited by the allocations, each PB outstanding follows, GL 2110 = Σ PB outstanding', () => {
    const st = buildSeedState();
    const b1 = pb(st, 'b1'), b2 = pb(st, 'b2', '2000.00'); // totals 10,700.00 and 2,140.00
    const d = createDraft(st, 'co-vat', 'PV', { header: hdr('pv-01'), lines: [], allocations: [
      { targetId: b1.id, targetType: 'PB', amount: '700.00' }, { targetId: b2.id, targetType: 'PB', amount: '2140.00' }] }, USER, 'pv1');
    const done = issue(st, d.id, d.version, USER);
    expect([done.totals.total, done.totals.wht, done.totals.cash]).toEqual(['2840.00', '0.00', '2840.00']);
    expect([out(st, b1.id), out(st, b2.id)]).toEqual([1000000, 0]);
    expect(st.docs.find((x) => x.id === b2.id)!.status).toBe('settled');
    expect(st.docs.find((x) => x.id === b1.id)!.status).toBe('partly_settled');
    expect([row(st, done.id, '2110')?.debit, row(st, done.id, '1121')?.credit]).toEqual(['2840.00', '2840.00']);
    assertBalanced(st); // includes the 2110 subledger invariant
  });
  it('PV: over-paying a bill is refused; cancelling the PV puts the bill back', () => {
    const st = buildSeedState();
    const b = pb(st, 'b3');
    const bad = createDraft(st, 'co-vat', 'PV', { header: hdr('pv-01'), lines: [], allocations: [{ targetId: b.id, targetType: 'PB', amount: '10700.01' }] }, USER, 'pvbad');
    expect(() => issue(st, bad.id, bad.version, USER)).toThrow(/settle.over_allocation/);
    const ok = createDraft(st, 'co-vat', 'PV', { header: hdr('pv-01'), lines: [], allocations: [{ targetId: b.id, targetType: 'PB', amount: '10700.00' }] }, USER, 'pvok');
    const done = issue(st, ok.id, ok.version, USER);
    expect(out(st, b.id)).toBe(0);
    cancel(st, done.id, done.version, 'OTHER', 'x', USER);
    expect(out(st, b.id)).toBe(1070000);
    assertBalanced(st);
  });
  it('PV alloc WHT is refused (the voucher withholds from its lines, settle.wht_not_allowed); an RC cannot target a PB', () => {
    const st = buildSeedState();
    const b = pb(st, 'b4');
    const pv = createDraft(st, 'co-vat', 'PV', { header: hdr('pv-01'), lines: [], allocations: [{ targetId: b.id, targetType: 'PB', amount: '100.00', wht: '3.00' }] }, USER, 'pvw');
    expect(() => issue(st, pv.id, pv.version, USER)).toThrow(/settle.wht_not_allowed/);
    const rc = createDraft(st, 'co-vat', 'RC', { header: hdr('pv-01'), lines: [], allocations: [{ targetId: b.id, targetType: 'PB', amount: '100.00' }] }, USER, 'rcpb');
    expect(() => issue(st, rc.id, rc.version, USER)).toThrow(/settle.wrong_type/);
  });
  it('revising a PV re-points its settlements: the old bill is released, the new one taken', () => {
    const st = buildSeedState();
    const b1 = pb(st, 'b5'), b2 = pb(st, 'b6');
    const d = createDraft(st, 'co-vat', 'PV', { header: hdr('pv-01'), lines: [], allocations: [{ targetId: b1.id, targetType: 'PB', amount: '500.00' }] }, USER, 'pvr');
    const done = issue(st, d.id, d.version, USER);
    revise(st, done.id, { header: done.header, lines: [], allocations: [{ targetId: b2.id, targetType: 'PB', amount: '800.00' }] }, done.version, 'จ่ายผิดใบ', USER);
    expect([out(st, b1.id), out(st, b2.id)]).toEqual([1070000, 1070000 - 80000]);
    expect(st.links.filter((l) => l.from === done.id && l.active).map((l) => l.to)).toEqual([b2.id]);
    assertBalanced(st);
  });
  it('EX allocations post to EmployeePayable 2180 (posting only: the EX document arrives in P4)', () => {
    const st = buildSeedState();
    const pv = { ...structuredClone(st.docs.find((d) => d.type === 'TI')!), type: 'PV' as const, lines: [], allocations: [{ targetId: 'ex-1', targetType: 'EX' as const, amount: '300.00' }],
      totals: { gross: '0.00', discount: '0.00', net: '0.00', vat: '0.00', total: '300.00', wht: '0.00', cash: '300.00', amountInWords: '' } };
    expect(ledgerFor(st, pv).entries[0].lines.map((l) => [l.accountCode, l.debit, l.credit])).toEqual([['2180', '300.00', '0.00'], ['1120', '0.00', '300.00']]);
  });
});

describe('RC revise (T-class): a certificate number is not fiscal, the money is', () => {
  it('editing certNumber revises in place and keeps the links; changing an amount needs a correction plan', () => {
    const st = buildSeedState();
    const { rc } = multiRc(st, 'cert');
    const done = issue(st, rc.id, rc.version, USER);
    const linksBefore = JSON.stringify(st.links.filter((l) => l.from === done.id));
    const withCert = done.allocations!.map((a, i) => (i === 0 ? { ...a, certNumber: 'ท.2569/0451' } : a));
    const r = revise(st, done.id, { header: done.header, lines: [], allocations: withCert }, done.version, 'บันทึกเลขที่หนังสือรับรองหัก ณ ที่จ่าย', USER);
    expect(r.allocations![0].certNumber).toBe('ท.2569/0451');
    expect(st.revisions.find((v) => v.docId === done.id && v.revision === 1)!.diff).toEqual([{ path: `allocations.${done.allocations![0].targetId}.certNumber`, before: null, after: 'ท.2569/0451' }]); // diffBody covers allocations
    expect(JSON.stringify(st.links.filter((l) => l.from === done.id))).toBe(linksBefore);
    const changed = r.allocations!.map((a, i) => (i === 1 ? { ...a, amount: '400.00' } : a));
    expect(() => revise(st, done.id, { header: done.header, lines: [], allocations: changed }, r.version, 'x', USER)).toThrow(/doc.revise_not_allowed/);
    const plan = correctionPlan(st, done.id, { header: done.header, lines: [], allocations: changed }, 'accountant');
    expect(plan.steps.map((s) => [s.action, s.docType])).toEqual([['cancel', 'RC'], ['reissue', 'RC']]);
    assertBalanced(st);
  });
});
